import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL("../../", import.meta.url);
const commandTimeoutMs = 120_000;
const checksum = (value) =>
  createHash("sha256").update(value).digest("hex");
const contractChecksum = (digit) => `sha256:${digit.repeat(64)}`;

async function run(command, arguments_, options = {}) {
  return execFileAsync(command, arguments_, {
    timeout: commandTimeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.ok(address);
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForDeepGatewayProbe(environment) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const result = await run(
        "openclaw",
        ["gateway", "status", "--deep", "--require-rpc"],
        { env: environment, timeout: 5_000 },
      );
      assert.match(result.stdout, /Read probe: ok/i);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

async function probeTypedHooks(openClawRoot) {
  const runtime = await import(
    pathToFileURL(
      join(openClawRoot, "dist", "plugin-sdk", "plugin-runtime.js"),
    ).href
  );
  const runId = "00000000-0000-4000-8000-000000000004";
  const sessionKey = "agent:main:synthetic-smoke";
  const observed = [];
  const registration = (hookName, handler) => ({
    pluginId: "cognitive-runtime-smoke-probe",
    hookName,
    handler,
    source: "synthetic-pack-install-smoke",
  });

  runtime.initializeGlobalHookRunner({
    hooks: [],
    typedHooks: [
      registration("before_prompt_build", (event, context) => {
        observed.push({ hook: "before_prompt_build", event, context });
      }),
      registration("after_tool_call", (event, context) => {
        observed.push({ hook: "after_tool_call", event, context });
      }),
      registration("before_agent_finalize", (event, context) => {
        observed.push({ hook: "before_agent_finalize", event, context });
      }),
      registration("agent_end", (event, context) => {
        observed.push({ hook: "agent_end", event, context });
      }),
    ],
    plugins: [{ id: "cognitive-runtime-smoke-probe", status: "loaded" }],
  });

  try {
    const runner = runtime.getGlobalHookRunner();
    assert.ok(runner);
    await runner.runBeforePromptBuild(
      { prompt: "Synthetic prompt", messages: [] },
      { runId, sessionKey, agentId: "main" },
    );
    await runner.runAfterToolCall(
      {
        toolName: "memory_search",
        params: { query: "synthetic" },
        runId,
        toolCallId: "tool-memory-1",
        result: {
          content: [{ stable_refs: ["sem-synthetic"] }],
          details: { results: [{ source_id: "src-synthetic" }] },
        },
      },
      {
        toolName: "memory_search",
        runId,
        toolCallId: "tool-memory-1",
        sessionKey,
      },
    );
    await runner.runBeforeAgentFinalize(
      {
        runId,
        sessionId: "session-synthetic",
        sessionKey,
        stopHookActive: false,
        messages: [],
      },
      { runId, sessionKey, agentId: "main" },
    );
    await runner.runAgentEnd(
      { runId, messages: [], success: true },
      { runId, sessionKey, agentId: "main" },
    );
  } finally {
    runtime.resetGlobalHookRunner();
  }

  assert.deepEqual(
    observed.map(({ hook }) => hook),
    [
      "before_prompt_build",
      "after_tool_call",
      "before_agent_finalize",
      "agent_end",
    ],
  );
  assert.equal(
    observed.every(({ event, context }) =>
      (event.runId ?? context.runId) === runId &&
      context.runId === runId &&
      context.sessionKey === sessionKey
    ),
    true,
  );
  return observed[1].event.result;
}

async function verifyPackedAdapters(pluginRoot, memoryResult) {
  const runtime = await import(
    pathToFileURL(join(pluginRoot, "dist", "index.js")).href
  );
  const stateRuntime = await import(
    pathToFileURL(join(pluginRoot, "dist", "state", "index.js")).href
  );
  const routerResult = {
    memory_route: "none",
    state_refs: [],
    governing: null,
    frameworks: { primary: null, secondary: null },
    retrieval_plan: [],
    confidence: 1,
    reason_codes: ["CURRENT_CONTEXT_SUFFICIENT"],
  };
  const entries = [];
  const registryChecksum = runtime.calculateRegistryChecksum(entries);
  let completionCalls = 0;
  const hostLlm = {
    complete: async (prompt) => {
      completionCalls += 1;
      const requestPayload = JSON.parse(prompt);
      assert.equal(
        requestPayload.instruction,
        "Return exactly one Router Result JSON object.",
      );
      assert.equal(requestPayload.current_message, "Synthetic decision");
      return JSON.stringify(routerResult);
    },
  };
  const router = new runtime.StrictRouter({ complete: hostLlm.complete });
  const request = {
    currentMessage: "Synthetic decision",
    recentContext: [],
    stateViewVersion: "view-1",
    activeGoverningSystem: null,
    syncGeneration: "generation-1",
    expectedRegistryChecksum: registryChecksum,
    registry: { checksum: registryChecksum, entries },
  };
  assert.deepEqual(await router.route(request), {
    status: "ok",
    result: routerResult,
  });
  assert.equal(completionCalls, 1);
  const degraded = new runtime.StrictRouter({
    complete: async () => `not-json:${JSON.stringify(routerResult)}`,
  });
  assert.deepEqual(await degraded.route(request), {
    status: "degraded",
    reasonCode: "ROUTER_NON_JSON_OUTPUT",
  });

  const memory = new runtime.MemoryObservationAdapter();
  assert.deepEqual(
    memory.observe({ toolCallId: "tool-memory-1", ...memoryResult }),
    {
      toolCallId: "tool-memory-1",
      stableRefs: ["sem-synthetic", "src-synthetic"],
    },
  );

  const scratch = new runtime.RunScratchMap({ capacity: 2, ttlMs: 50 });
  const binding = {
    syncGeneration: "generation-1",
    authorityRevision: "authority-synthetic",
    stateViewVersion: "view-1",
    registryChecksum,
    stateView: { value: "fixed" },
    routerResult,
  };
  await Promise.all([
    scratch.acquire("run-command", binding),
    scratch.acquire("run-ui", { ...binding, stateViewVersion: "view-2" }),
  ]);
  const repeated = await scratch.acquire("run-command", structuredClone(binding));
  assert.equal(repeated.binding.stateViewVersion, "view-1");
  await assert.rejects(
    scratch.acquire("run-over-capacity", binding),
    /RUN_SCRATCH_CAPACITY/,
  );
  await Promise.all([
    scratch.observe("run-command", {
      toolCallId: "tool-a",
      stableRefs: ["sem-a"],
    }),
    scratch.observe("run-command", {
      toolCallId: "tool-a",
      stableRefs: ["sem-duplicate"],
    }),
  ]);
  assert.equal(scratch.inspect("run-command")?.observations.length, 1);
  await scratch.release("run-command");
  assert.equal(scratch.inspect("run-command"), null);
  assert.equal(scratch.clearLifecycle("restart"), 1);

  let now = 1_000;
  const expiringScratch = new runtime.RunScratchMap({
    capacity: 1,
    ttlMs: 10,
    now: () => now,
  });
  await expiringScratch.acquire("run-expiring", binding);
  now += 11;
  assert.equal(expiringScratch.cleanupExpired(), 1);

  assert.equal(typeof runtime.SqliteReanswerStore, "undefined");
  assert.equal(typeof stateRuntime.SqliteReanswerStore, "function");
  const stateStore = new stateRuntime.SqliteReanswerStore({
    databasePath: ":memory:",
    initialHead: {
      active_seq: 0,
      view_version: "view-0",
      checksum: contractChecksum("0"),
      activated_at: "2026-08-11T00:00:00Z",
    },
  });
  try {
    const sessionKeyHash = contractChecksum("1");
    const correction = (sequence, id) => ({
      event: {
        seq: sequence,
        event_id: `event-${id}`,
        state_id: "state-synthetic",
        event_type: "correction",
        payload: { value: id },
        observed_at: "2026-08-11T00:00:01Z",
        source_kind: "user_explicit",
        idempotency_key: `event-key-${id}`,
        created_at: "2026-08-11T00:00:02Z",
      },
      newHead: {
        active_seq: sequence,
        view_version: `view-${sequence}`,
        checksum: contractChecksum(String(sequence)),
        activated_at: "2026-08-11T00:00:03Z",
      },
      outbox: {
        correctionId: `correction-${id}`,
        instanceId: "instance-synthetic",
        sessionKeyHash,
        priorRunId: `run-prior-${sequence}`,
        idempotencyKey: `outbox-key-${id}`,
        createdAt: "2026-08-11T00:00:03Z",
      },
    });

    await stateStore.correct(correction(1, "command"));
    const commandClaim = await stateStore.claim("correction-command", {
      successorRunId: "run-command",
      deliveryMode: "command_continuation",
    });
    assert.ok(commandClaim);
    await stateStore.release(commandClaim, "HOST_ABORTED");
    const retry = await stateStore.claim("correction-command", {
      successorRunId: "run-command-retry",
      deliveryMode: "command_continuation",
    });
    assert.ok(retry);
    await stateStore.complete(retry);

    await stateStore.correct(correction(2, "ui"));
    const uiClaim = await stateStore.claim("correction-ui", {
      successorRunId: "run-ui",
      deliveryMode: "ui_normal_rpc",
    });
    assert.ok(uiClaim);
    await stateStore.complete(uiClaim);
    assert.notEqual(retry.successorRunId, uiClaim.successorRunId);
    assert.equal(stateStore.get("correction-command")?.instance_id, "instance-synthetic");
    assert.equal(stateStore.get("correction-ui")?.instance_id, "instance-synthetic");
  } finally {
    stateStore.close();
  }
}

test("packed runtime passes the exact OpenClaw host smoke and restores configuration", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-runtime-openclaw-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "openclaw.json");
  const backupPath = join(root, "pre-install-openclaw.json");
  const port = await reservePort();
  const token = ["synthetic", "gateway", "token"].join("-");
  const originalConfig = `${JSON.stringify({
    gateway: {
      mode: "local",
      bind: "loopback",
      port,
      auth: { mode: "token", token },
    },
  }, null, 2)}\n`;
  await writeFile(configPath, originalConfig, { mode: 0o600 });
  await copyFile(configPath, backupPath);
  const originalChecksum = checksum(await readFile(backupPath));
  const environment = {
    ...process.env,
    HOME: root,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: join(root, "state"),
    OPENCLAW_GATEWAY_TOKEN: token,
    npm_config_cache: join(root, "npm-cache"),
  };
  let installed = false;
  let gateway;

  try {
    const { stdout: versionOutput } = await run("openclaw", ["--version"], {
      env: environment,
    });
    assert.match(versionOutput, /2026\.6\.34 \(5c38f99\)/);

    const { stdout: packOutput } = await run(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", root],
      { cwd: repositoryRoot, env: environment },
    );
    const [pack] = JSON.parse(packOutput);
    const tarball = join(root, pack.filename);

    await run(
      "openclaw",
      ["plugins", "install", `npm-pack:${tarball}`],
      { env: environment },
    );
    installed = true;

    const { stdout: inspectOutput } = await run(
      "openclaw",
      ["plugins", "inspect", "cognitive-runtime", "--runtime", "--json"],
      { env: environment },
    );
    const inspection = JSON.parse(inspectOutput);
    assert.equal(inspection.plugin.status, "loaded");
    assert.equal(
      inspection.plugin.source.endsWith("/dist/openclaw/index.js"),
      true,
    );
    assert.deepEqual(inspection.plugin.cliCommands, ["cognitive"]);
    assert.equal(inspection.plugin.configJsonSchema.additionalProperties, false);
    const pluginRoot = dirname(dirname(dirname(inspection.plugin.source)));
    const installedPluginSource = await readFile(inspection.plugin.source, "utf8");
    for (const rejectedPath of [
      "runContext",
      "enqueueNextTurnInjection",
      "runEmbeddedAgent",
      "scheduleSessionTurn",
    ]) {
      assert.equal(installedPluginSource.includes(rejectedPath), false);
    }
    const compatibility = JSON.parse(
      await readFile(join(pluginRoot, "compatibility", "openclaw.json"), "utf8"),
    );
    assert.equal(compatibility.hosts[0].releaseChannel, "extended-stable");
    assert.equal(compatibility.hosts[0].openclawVersion, "2026.6.34");
    assert.deepEqual(
      compatibility.hosts[0].capabilityExpectations.typedHooks.hooks,
      [
        "before_prompt_build",
        "after_tool_call",
        "before_agent_finalize",
        "agent_end",
      ],
    );

    const { stdout: selfCheckOutput } = await run(
      "openclaw",
      ["cognitive", "self-check"],
      { env: environment },
    );
    assert.deepEqual(JSON.parse(selfCheckOutput.trim()), {
      status: "ok",
      pluginId: "cognitive-runtime",
      hostCapabilities: {
        hostModelCompletion: "llm.complete",
      },
    });

    const { stdout: skillOutput } = await run(
      "openclaw",
      ["skills", "info", "framework-admission", "--json"],
      { env: environment },
    );
    const skill = JSON.parse(skillOutput);
    assert.equal(skill.name, "framework-admission");
    assert.equal(skill.eligible, true);

    const { stdout: npmRootOutput } = await run("npm", ["root", "-g"], {
      env: environment,
    });
    const openClawRoot = join(npmRootOutput.trim(), "openclaw");
    const memoryResult = await probeTypedHooks(openClawRoot);
    await verifyPackedAdapters(pluginRoot, memoryResult);
  } finally {
    if (installed) {
      await run(
        "openclaw",
        ["plugins", "uninstall", "cognitive-runtime", "--force"],
        { env: environment },
      );
    }
    await copyFile(backupPath, configPath);
    assert.equal(checksum(await readFile(configPath)), originalChecksum);

    gateway = spawn(
      "openclaw",
      [
        "gateway",
        "run",
        "--port",
        String(port),
        "--bind",
        "loopback",
        "--token",
        token,
      ],
      { env: environment, stdio: "ignore" },
    );
    try {
      await waitForDeepGatewayProbe(environment);
    } finally {
      gateway.kill("SIGTERM");
      await new Promise((resolve) => {
        gateway.once("exit", resolve);
        setTimeout(resolve, 5_000);
      });
    }
  }
});
