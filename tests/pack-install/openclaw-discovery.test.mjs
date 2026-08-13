import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL("../../", import.meta.url);
const commandTimeoutMs = 240_000;
const checksum = (value) =>
  createHash("sha256").update(value).digest("hex");
const contractChecksum = (digit) => `sha256:${digit.repeat(64)}`;

function parseJsonOutput(output) {
  const start = output.indexOf("{");
  assert.notEqual(start, -1, `JSON output missing: ${output}`);
  return JSON.parse(output.slice(start));
}

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

async function waitForDeepGatewayProbe(environment, attempts = 30) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
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

function routerResult() {
  return {
    memory_route: "none",
    state_refs: [],
    governing: null,
    frameworks: { primary: null, secondary: null },
    retrieval_plan: [],
    confidence: 1,
    reason_codes: ["CURRENT_CONTEXT_SUFFICIENT"],
  };
}

function sendOpenAiResponse(response, body, content, toolCall) {
  const id = "chatcmpl-synthetic";
  const model = body.model ?? "synthetic-model";
  if (body.stream === true) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = toolCall === undefined
      ? { role: "assistant", content }
      : {
          role: "assistant",
          tool_calls: [{
            index: 0,
            id: "call-synthetic-memory",
            type: "function",
            function: {
              name: toolCall,
              arguments: JSON.stringify({ query: "synthetic" }),
            },
          }],
        };
    response.write(`data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: toolCall === undefined ? "stop" : "tool_calls",
      }],
    })}\n\n`);
    response.end("data: [DONE]\n\n");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id,
    object: "chat.completion",
    created: 1,
    model,
    choices: [{
      index: 0,
      message: toolCall === undefined
        ? { role: "assistant", content }
        : {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call-synthetic-memory",
              type: "function",
              function: {
                name: toolCall,
                arguments: JSON.stringify({ query: "synthetic" }),
              },
            }],
          },
      finish_reason: toolCall === undefined ? "stop" : "tool_calls",
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
}

async function startSyntheticModelServer(port) {
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404);
      response.end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    const latestUser = [...(body.messages ?? [])]
      .reverse()
      .find((message) => message.role === "user");
    const latestUserContent = JSON.stringify(latestUser?.content ?? "");
    if (latestUserContent.includes("ROUTER_INVALID")) {
      sendOpenAiResponse(response, body, "not-json", undefined);
      return;
    }
    if (latestUserContent.includes("ROUTER_VALID")) {
      sendOpenAiResponse(response, body, JSON.stringify(routerResult()), undefined);
      return;
    }
    if (latestUserContent.includes("Return exactly one Router Result JSON object.")) {
      sendOpenAiResponse(response, body, JSON.stringify(routerResult()), undefined);
      return;
    }
    if (latestUserContent.includes("PLAIN_RUN_ABORT")) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: {
          message: "Synthetic host abort",
          type: "invalid_request_error",
          code: "synthetic_host_abort",
        },
      }));
      return;
    }
    const hasToolResult = (body.messages ?? []).some(
      (message) => message.role === "tool",
    );
    if (latestUserContent.includes("MEMORY_RUN") && !hasToolResult) {
      sendOpenAiResponse(response, body, undefined, "synthetic_memory");
      return;
    }
    sendOpenAiResponse(response, body, "Synthetic host response", undefined);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    requests,
    close: () => new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
    closeAllConnections: () => server.closeAllConnections(),
  };
}

async function closeModelServer(modelServer) {
  const closePromise = modelServer.close();
  const forceTimer = setTimeout(() => modelServer.closeAllConnections(), 5_000);
  let hardTimer;
  const hardTimeout = new Promise((_, reject) => {
    hardTimer = setTimeout(
      () => reject(new Error("SYNTHETIC_MODEL_SERVER_CLOSE_TIMEOUT")),
      10_000,
    );
  });
  try {
    await Promise.race([closePromise, hardTimeout]);
  } finally {
    clearTimeout(forceTimer);
    clearTimeout(hardTimer);
  }
}

function spawnGateway(port, token, environment) {
  const gateway = spawn(
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
    { env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  gateway.diagnostics = "";
  gateway.stdout.on("data", (chunk) => { gateway.diagnostics += chunk.toString(); });
  gateway.stderr.on("data", (chunk) => { gateway.diagnostics += chunk.toString(); });
  gateway.on("error", (error) => {
    gateway.diagnostics += `${error.message}\n`;
  });
  return gateway;
}

async function stopGateway(gateway) {
  if (gateway.exitCode !== null || gateway.signalCode !== null) {
    return;
  }
  const waitForExit = (timeoutMs) => new Promise((resolve) => {
    let timeout;
    const finish = (exited) => {
      clearTimeout(timeout);
      gateway.off("exit", onExit);
      gateway.off("error", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    timeout = setTimeout(() => finish(false), timeoutMs);
    gateway.once("exit", onExit);
    gateway.once("error", onExit);
  });
  gateway.kill("SIGTERM");
  if (await waitForExit(5_000)) {
    return;
  }
  gateway.kill("SIGKILL");
  if (!await waitForExit(5_000)) {
    throw new Error(`OPENCLAW_GATEWAY_STOP_TIMEOUT\n${gateway.diagnostics}`);
  }
}

async function readProbeEvidence(evidencePath, minimumAgentEnds) {
  let content = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    content = await readFile(evidencePath, "utf8").catch(() => "");
    const entries = content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (entries.filter((entry) => entry.hook === "agent_end").length >= minimumAgentEnds) {
      return entries;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`SYNTHETIC_HOST_PROBE_EVIDENCE_TIMEOUT\n${content}`);
}

async function verifyHostRouter(environment) {
  const { stdout } = await run(
    "openclaw",
    ["cognitive-probe", "router"],
    { env: environment },
  );
  const result = parseJsonOutput(stdout);
  assert.deepEqual(result.valid, { status: "ok", result: routerResult() });
  assert.deepEqual(result.invalid, {
    status: "degraded",
    reasonCode: "ROUTER_NON_JSON_OUTPUT",
  });
  assert.deepEqual(result.generic, { status: "ok", result: routerResult() });
}

async function runHostSuccessors(environment, evidencePath, port, token) {
  await run("openclaw", ["cognitive-probe", "seed", "command"], {
    env: environment,
  });
  let abortedCommand;
  try {
    await run(
      "openclaw",
      [
        "agent",
        "--session-key",
        environment.STELLA_RUNTIME_PROBE_SESSION_KEY,
        "--message",
        "PLAIN_RUN_ABORT",
        "--json",
        "--timeout",
        "10",
      ],
      { env: environment },
    );
    assert.fail("Synthetic abort unexpectedly succeeded");
  } catch (error) {
    assert.match(error.stderr ?? "", /provider rejected the request/i);
    abortedCommand = {
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
  await readProbeEvidence(evidencePath, 1);
  const commandResult = await run(
    "openclaw",
    [
      "agent",
      "--session-key",
      environment.STELLA_RUNTIME_PROBE_SESSION_KEY,
      "--message",
      "PLAIN_RUN_RETRY",
      "--json",
      "--timeout",
      "10",
    ],
    { env: environment },
  );
  await readProbeEvidence(evidencePath, 2);
  await run("openclaw", ["cognitive-probe", "seed", "ui"], {
    env: environment,
  });
  const uiResult = await run(
    "openclaw",
    [
      "gateway",
      "call",
      "chat.send",
      "--url",
      `ws://127.0.0.1:${port}`,
      "--token",
      token,
      "--expect-final",
      "--json",
      "--timeout",
      "10000",
      "--params",
      JSON.stringify({
        sessionKey: environment.STELLA_RUNTIME_PROBE_SESSION_KEY,
        message: "MEMORY_RUN",
        idempotencyKey: "00000000-0000-4000-8000-000000000004",
      }),
    ],
    { env: environment },
  );

  let evidence;
  try {
    evidence = await readProbeEvidence(evidencePath, 3);
  } catch (error) {
    throw new Error([
      error.message,
      `ABORT_STDOUT=${abortedCommand.stdout}`,
      `ABORT_STDERR=${abortedCommand.stderr}`,
      `COMMAND_STDOUT=${commandResult.stdout}`,
      `COMMAND_STDERR=${commandResult.stderr}`,
      `UI_STDOUT=${uiResult.stdout}`,
      `UI_STDERR=${uiResult.stderr}`,
    ].join("\n"));
  }
  const promptEntries = evidence.filter(
    (entry) => entry.hook === "before_prompt_build",
  );
  const abortedRun = promptEntries.find(
    (entry) => entry.runKind === "command_abort",
  );
  const commandRun = promptEntries.find(
    (entry) => entry.runKind === "command_retry",
  );
  const uiRun = promptEntries.find((entry) => entry.runKind === "memory");
  const evidenceDiagnostic = JSON.stringify(evidence, null, 2);
  assert.ok(abortedRun?.runId, evidenceDiagnostic);
  assert.ok(commandRun?.runId, evidenceDiagnostic);
  assert.ok(uiRun?.runId, evidenceDiagnostic);
  assert.notEqual(abortedRun.runId, commandRun.runId);
  assert.notEqual(commandRun.runId, uiRun.runId);
  assert.match(abortedRun.newViewVersion, /^state-view-1-[a-f0-9]{12}$/);
  assert.ok(abortedRun.nestedCompletionTextLength > 0, JSON.stringify(abortedRun));
  assert.equal(abortedRun.claimAttempt, 1);
  assert.equal(commandRun.newViewVersion, abortedRun.newViewVersion);
  assert.equal(commandRun.claimAttempt, 2);
  assert.match(uiRun.newViewVersion, /^state-view-2-[a-f0-9]{12}$/);
  assert.equal(uiRun.claimAttempt, 1);

  const uiHooks = evidence
    .filter((entry) => entry.runId === uiRun.runId)
    .map((entry) => entry.hook);
  assert.deepEqual(uiHooks, [
    "before_prompt_build",
    "after_tool_call",
    "before_agent_finalize",
    "agent_end",
  ]);
  assert.equal(
    evidence
      .filter((entry) => [
        abortedRun.runId,
        commandRun.runId,
        uiRun.runId,
      ].includes(entry.runId))
      .every(
        (entry) =>
          entry.sessionKey === environment.STELLA_RUNTIME_PROBE_SESSION_KEY,
      ),
    true,
  );
  const abortedEnd = evidence.find(
    (entry) => entry.runId === abortedRun.runId && entry.hook === "agent_end",
  );
  assert.equal(abortedEnd?.disposition, "released");
  assert.equal(abortedEnd?.outbox.status, "pending");
  assert.equal(abortedEnd?.outbox.last_error_code, "HOST_ABORTED");
  assert.equal(
    evidence
      .filter((entry) =>
        entry.hook === "agent_end" && entry.runId !== abortedRun.runId
      )
      .every((entry) => entry.success && entry.activeRunCount === 0),
    true,
  );
  const memoryTool = evidence.find(
    (entry) => entry.runId === uiRun.runId && entry.hook === "after_tool_call",
  );
  assert.equal(memoryTool?.toolName, "synthetic_memory");
  assert.equal(typeof memoryTool?.toolCallId, "string");
  const { stdout: storeOutput } = await run(
    "openclaw",
    ["cognitive-probe", "inspect"],
    { env: environment },
  );
  const store = parseJsonOutput(storeOutput);
  assert.equal(store.command.status, "completed");
  assert.equal(store.command.successor_run_id, commandRun.runId);
  assert.equal(store.command.attempt_count, 2);
  assert.equal(store.command.successful_completion_count, 1);
  assert.equal(store.ui.status, "completed");
  assert.equal(store.ui.successor_run_id, uiRun.runId);
  assert.equal(store.ui.new_view_version, uiRun.newViewVersion);
  assert.equal(store.ui.successful_completion_count, 1);
  assert.equal(store.head.view_version, uiRun.newViewVersion);
  assert.equal(store.eventCount, 2);
  return {
    abortedRunId: abortedRun.runId,
    commandRunId: commandRun.runId,
    uiRunId: uiRun.runId,
    sessionKey: environment.STELLA_RUNTIME_PROBE_SESSION_KEY,
    memoryResult: memoryTool.result,
  };
}

async function listJavaScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJavaScriptFiles(path)));
    } else if (entry.name.endsWith(".js")) {
      files.push(path);
    }
  }
  return files;
}

async function verifyRejectedPathsAbsent(pluginRoot) {
  const source = (
    await Promise.all(
      (await listJavaScriptFiles(join(pluginRoot, "dist"))).map(
        (path) => readFile(path, "utf8"),
      ),
    )
  ).join("\n");
  for (const rejectedPath of [
    "runContext",
    "enqueueNextTurnInjection",
    "runEmbeddedAgent",
    "scheduleSessionTurn",
  ]) {
    assert.equal(source.includes(rejectedPath), false);
  }
}

async function verifyMemoryAdapter(runtime, memoryResult) {
  const memory = new runtime.MemoryObservationAdapter();
  assert.deepEqual(
    memory.observe({ toolCallId: "tool-memory-1", ...memoryResult }),
    {
      toolCallId: "tool-memory-1",
      stableRefs: ["sem-synthetic", "src-synthetic"],
    },
  );
}

async function verifyRunScratch(runtime, successors) {
  const registryChecksum = runtime.calculateRegistryChecksum([]);
  const scratch = new runtime.RunScratchMap({ capacity: 2, ttlMs: 50 });
  const binding = {
    syncGeneration: "generation-1",
    authorityRevision: "authority-synthetic",
    stateViewVersion: "view-1",
    registryChecksum,
    stateView: { value: "fixed" },
    routerResult: routerResult(),
  };
  await Promise.all([
    scratch.acquire(successors.commandRunId, binding),
    scratch.acquire(successors.uiRunId, { ...binding, stateViewVersion: "view-2" }),
  ]);
  const repeated = await scratch.acquire(
    successors.commandRunId,
    structuredClone(binding),
  );
  assert.equal(repeated.binding.stateViewVersion, "view-1");
  await assert.rejects(
    scratch.acquire("run-over-capacity", binding),
    /RUN_SCRATCH_CAPACITY/,
  );
  await assert.rejects(scratch.acquire("", binding), /RUN_ID_REQUIRED/);
  await assert.rejects(
    scratch.acquire(successors.commandRunId, {
      ...binding,
      stateViewVersion: "view-conflict",
    }),
    /RUN_BINDING_CONFLICT/,
  );
  await Promise.all([
    scratch.observe(successors.commandRunId, {
      toolCallId: "tool-a",
      stableRefs: ["sem-a"],
    }),
    scratch.observe(successors.commandRunId, {
      toolCallId: "tool-a",
      stableRefs: ["sem-duplicate"],
    }),
  ]);
  assert.equal(
    scratch.inspect(successors.commandRunId)?.observations.length,
    1,
  );
  assert.equal(scratch.inspect(successors.sessionKey), null);
  await scratch.release(successors.commandRunId);
  assert.equal(scratch.inspect(successors.commandRunId), null);
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
}

async function verifyReanswerStore(runtime, stateRuntime, successors) {
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
    const sessionKeyHash = `sha256:${checksum(successors.sessionKey)}`;
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
      outbox: {
        correctionId: `correction-${id}`,
        instanceId: "instance-synthetic",
        sessionKeyHash,
        priorRunId: `run-prior-${sequence}`,
        idempotencyKey: `outbox-key-${id}`,
        createdAt: "2026-08-11T00:00:03Z",
      },
    });

    const first = await stateStore.correct(correction(1, "command"));
    assert.deepEqual(await stateStore.correct(correction(1, "command")), first);
    await assert.rejects(
      stateStore.correct(correction(2, "blocked")),
      /REANSWER_SESSION_BUSY/,
    );
    assert.equal(stateStore.getEventCount(), 1);
    assert.equal(stateStore.getHead().view_version, first.new_view_version);

    const commandClaims = await Promise.all([
      stateStore.claim("correction-command", {
        successorRunId: successors.commandRunId,
        deliveryMode: "command_continuation",
      }),
      stateStore.claim("correction-command", {
        successorRunId: "run-command-race",
        deliveryMode: "command_continuation",
      }),
    ]);
    assert.equal(commandClaims.filter(Boolean).length, 1);
    const commandClaim = commandClaims.find(Boolean);
    assert.ok(commandClaim);
    await stateStore.release(commandClaim, "HOST_ABORTED");
    const retry = await stateStore.claim("correction-command", {
      successorRunId: successors.commandRunId,
      deliveryMode: "command_continuation",
    });
    assert.ok(retry);
    await stateStore.complete(retry);
    await assert.rejects(stateStore.complete(retry), /REANSWER_CAS_FAILED/);
    assert.equal(await stateStore.claim("correction-command", {
      successorRunId: "run-command-after-complete",
      deliveryMode: "command_continuation",
    }), null);

    await stateStore.correct(correction(2, "ui"));
    const uiClaim = await stateStore.claim("correction-ui", {
      successorRunId: successors.uiRunId,
      deliveryMode: "ui_normal_rpc",
    });
    assert.ok(uiClaim);
    await stateStore.complete(uiClaim);
    assert.notEqual(retry.successorRunId, uiClaim.successorRunId);
    const commandRecord = stateStore.get("correction-command");
    const uiRecord = stateStore.get("correction-ui");
    assert.equal(commandRecord?.session_key_hash, sessionKeyHash);
    assert.equal(uiRecord?.session_key_hash, sessionKeyHash);
    assert.match(uiRecord?.new_view_version ?? "", /^state-view-2-[a-f0-9]{12}$/);
    assert.equal(commandRecord?.successful_completion_count, 1);
    assert.equal(uiRecord?.successful_completion_count, 1);
  } finally {
    stateStore.close();
  }
}

async function verifyPackedAdapters(pluginRoot, successors) {
  const runtime = await import(
    pathToFileURL(join(pluginRoot, "dist", "index.js")).href
  );
  const stateRuntime = await import(
    pathToFileURL(join(pluginRoot, "dist", "state", "index.js")).href
  );
  await verifyMemoryAdapter(runtime, successors.memoryResult);
  await verifyRunScratch(runtime, successors);
  await verifyReanswerStore(runtime, stateRuntime, successors);
}

test("packed runtime passes the exact OpenClaw host smoke and restores configuration", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-runtime-openclaw-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "openclaw.json");
  const backupPath = join(root, "pre-install-openclaw.json");
  const evidencePath = join(root, "host-probe.jsonl");
  const databasePath = join(root, "reanswer.sqlite");
  const workspace = join(root, "workspace");
  const port = await reservePort();
  const modelPort = await reservePort();
  const token = ["synthetic", "gateway", "token"].join("-");
  const providerKey = ["synthetic", "provider", "credential"].join("-");
  const sessionKey = "agent:main:synthetic-smoke";
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "MEMORY.md"), "# Synthetic memory\n", "utf8");
  const originalConfig = `${JSON.stringify({
    gateway: {
      mode: "local",
      bind: "loopback",
      port,
      auth: { mode: "token", token },
    },
    agents: {
      defaults: {
        workspace,
        model: { primary: "synthetic/synthetic-model" },
        timeoutSeconds: 30,
      },
    },
    models: {
      mode: "merge",
      providers: {
        synthetic: {
          baseUrl: `http://127.0.0.1:${modelPort}/v1`,
          apiKey: providerKey,
          api: "openai-completions",
          models: [{
            id: "synthetic-model",
            name: "Synthetic Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 4096,
          }],
        },
      },
    },
    plugins: {
      entries: {
        "cognitive-runtime-host-probe": {
          enabled: true,
          hooks: { allowConversationAccess: true },
        },
      },
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
    STELLA_RUNTIME_PROBE_DATABASE: databasePath,
    STELLA_RUNTIME_PROBE_EVIDENCE: evidencePath,
    STELLA_RUNTIME_PROBE_SESSION_KEY: sessionKey,
    npm_config_cache: join(root, "npm-cache"),
  };
  const probeFixtureRoot = fileURLToPath(
    new URL("../fixtures/openclaw-host-probe/", import.meta.url),
  );
  const modelServer = await startSyntheticModelServer(modelPort);
  let runtimeInstalled = false;
  let probeInstalled = false;
  let gateway;
  let gatewayDiagnostics = "";

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
    runtimeInstalled = true;

    const { stdout: inspectOutput } = await run(
      "openclaw",
      ["plugins", "inspect", "cognitive-runtime", "--runtime", "--json"],
      { env: environment },
    );
    const inspection = parseJsonOutput(inspectOutput);
    assert.equal(inspection.plugin.status, "loaded");
    assert.equal(
      inspection.plugin.source.endsWith("/dist/openclaw/index.js"),
      true,
    );
    assert.deepEqual(inspection.plugin.cliCommands, ["cognitive"]);
    assert.equal(inspection.plugin.configJsonSchema.additionalProperties, false);
    const pluginRoot = dirname(dirname(dirname(inspection.plugin.source)));
    environment.STELLA_RUNTIME_PROBE_ROOT = pluginRoot;
    await verifyRejectedPathsAbsent(pluginRoot);

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
    assert.deepEqual(parseJsonOutput(selfCheckOutput), {
      status: "ok",
      pluginId: "cognitive-runtime",
      hostCapabilities: { hostModelCompletion: "llm.complete" },
    });
    const { stdout: skillOutput } = await run(
      "openclaw",
      ["skills", "info", "framework-admission", "--json"],
      { env: environment },
    );
    const skill = parseJsonOutput(skillOutput);
    assert.equal(skill.name, "framework-admission");
    assert.equal(skill.eligible, true);

    await run("openclaw", ["plugins", "install", probeFixtureRoot], {
      env: environment,
    });
    probeInstalled = true;
    const { stdout: probeInspectionOutput } = await run(
      "openclaw",
      [
        "plugins",
        "inspect",
        "cognitive-runtime-host-probe",
        "--runtime",
        "--json",
      ],
      { env: environment },
    );
    assert.equal(parseJsonOutput(probeInspectionOutput).plugin.status, "loaded");
    const installedConfig = JSON.parse(await readFile(configPath, "utf8"));
    installedConfig.plugins.entries["cognitive-runtime"] = {
      ...installedConfig.plugins.entries["cognitive-runtime"],
      enabled: true,
      hooks: {
        allowConversationAccess: true,
        allowPromptInjection: true,
      },
      config: {
        runtime: {
          mode: "enforce",
          limits: {
            routerTimeoutMs: 5_000,
            routerMaxTokens: 512,
            routerMaxInputCharacters: 8_000,
            routerMaxOutputCharacters: 8_000,
            packetMaxCharacters: 8_000,
            scratchCapacity: 8,
            scratchTtlMs: 60_000,
          },
          binding: {
            syncGeneration: "generation-synthetic",
            authorityRevision: "revision-synthetic",
            stateViewVersion: "view-synthetic",
            activeGoverningSystem: null,
            registry: {
              checksum: `sha256:${checksum("[]")}`,
              entries: [],
            },
            context: {
              stateView: [],
              semanticClaims: [],
              evidenceRefs: [],
              governing: null,
              frameworks: [],
            },
          },
        },
      },
    };
    await writeFile(configPath, `${JSON.stringify(installedConfig, null, 2)}\n`, {
      mode: 0o600,
    });
    const { stdout: configuredInspectionOutput } = await run(
      "openclaw",
      ["plugins", "inspect", "cognitive-runtime", "--runtime", "--json"],
      { env: environment },
    );
    assert.equal(
      parseJsonOutput(configuredInspectionOutput).plugin.status,
      "loaded",
    );
    assert.notEqual(
      parseJsonOutput(configuredInspectionOutput).plugin.policy?.allowPromptInjection,
      false,
    );
    await verifyHostRouter(environment);

    gateway = spawnGateway(port, token, environment);
    await waitForDeepGatewayProbe(environment);
    const successors = await runHostSuccessors(
      environment,
      evidencePath,
      port,
      token,
    );
    gatewayDiagnostics = gateway.diagnostics;
    await stopGateway(gateway);
    gateway = undefined;
    await verifyPackedAdapters(pluginRoot, successors);
    assert.equal(
      modelServer.requests.some((request) =>
        (request.tools ?? []).some(
          (tool) => tool.function?.name === "synthetic_memory",
        )),
      true,
    );
    assert.ok(
      modelServer.requests.some((request) =>
        JSON.stringify(request).includes("[synthetic_probe_injection]")),
      "synthetic probe prompt mutation was not applied",
    );
    assert.ok(
      modelServer.requests.some((request) =>
        JSON.stringify(request).includes("[current_input]")),
      JSON.stringify({
        gatewayDiagnostics: gatewayDiagnostics
          ?.split("\n")
          .filter((line) => /cognitive-runtime|router|packet/i.test(line)),
        requests: modelServer.requests.map((request) => ({
        stream: request.stream,
        messageRoles: (request.messages ?? []).map((message) => message.role),
        containsRouterInstruction: JSON.stringify(request).includes(
          "Return exactly one Router Result JSON object.",
        ),
        containsPacket: JSON.stringify(request).includes("[current_input]"),
        })),
      }, null, 2),
    );
  } finally {
    try {
      if (gateway !== undefined) {
        await stopGateway(gateway);
      }
      if (runtimeInstalled) {
        const cleanupConfig = JSON.parse(await readFile(configPath, "utf8"));
        const runtimeEntry = cleanupConfig.plugins?.entries?.["cognitive-runtime"];
        if (runtimeEntry !== undefined) {
          delete runtimeEntry.config;
          delete runtimeEntry.hooks;
          await writeFile(configPath, `${JSON.stringify(cleanupConfig, null, 2)}\n`, {
            mode: 0o600,
          });
        }
      }
      if (probeInstalled) {
        await run(
          "openclaw",
          ["plugins", "uninstall", "cognitive-runtime-host-probe", "--force"],
          { env: environment },
        );
      }
      if (runtimeInstalled) {
        await run(
          "openclaw",
          ["plugins", "uninstall", "cognitive-runtime", "--force"],
          { env: environment },
        );
      }
      await copyFile(backupPath, configPath);
      assert.equal(checksum(await readFile(configPath)), originalChecksum);
      gateway = spawnGateway(port, token, environment);
      try {
        await waitForDeepGatewayProbe(environment, 8);
      } finally {
        await stopGateway(gateway);
      }
    } finally {
      await closeModelServer(modelServer);
    }
  }
});
