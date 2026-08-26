import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
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
import {
  commitAuthorityChanges,
  commitSyntheticAuthority,
  writeSyntheticAuthority,
} from "../helpers/synthetic-authority.mjs";

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

function sendOpenAiResponse(response, body, content, toolCall, toolArguments = { query: "synthetic" }) {
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
              arguments: JSON.stringify(toolArguments),
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
                arguments: JSON.stringify(toolArguments),
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
  const control = {
    embeddingMode: "normal",
    embeddingFailureCount: 0,
    onEmbeddingRequest: undefined,
  };
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
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
    if (request.url === "/v1/embeddings") {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      control.onEmbeddingRequest?.();
      if (control.embeddingMode === "fail") {
        control.embeddingFailureCount += 1;
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Synthetic embedding failure" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        object: "list",
        model: body.model ?? "synthetic-embedding",
        data: inputs.map((input, index) => ({
          object: "embedding",
          index,
          embedding: control.embeddingMode === "search-miss"
            && String(input).includes("generation-")
            && !String(input).includes("\n")
            ? [0, 1, 0, 0, 0, 0, 0, 0]
            : [1, 0, 0, 0, 0, 0, 0, 0],
        })),
        usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
      }));
      return;
    }
    if (request.url !== "/v1/chat/completions") {
      response.writeHead(404);
      response.end();
      return;
    }
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
      const result = latestUserContent.includes("ELIGIBLE_GENERATION_RUN")
        ? {
            ...routerResult(),
            memory_route: "optional",
            retrieval_plan: [{
              layer: "semantic",
              method: "direct_get",
              target: "sem-synthetic-claim",
              query: null,
              purpose: "Use the prior activated semantic claim",
            }, {
              layer: "semantic",
              method: "direct_get",
              target: "sem-packed-accepted",
              query: null,
              purpose: "Use the newly published semantic claim",
            }],
            reason_codes: ["SYNTHETIC_ACTIVATED_GENERATION"],
          }
        : routerResult();
      sendOpenAiResponse(response, body, JSON.stringify(result), undefined);
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
    if (latestUserContent.includes("FITNESS_F2_RUN") && !hasToolResult) {
      sendOpenAiResponse(response, body, undefined, "memory_search", {
        query: "67.9 kg",
      });
      return;
    }
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
    control,
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

async function waitForGatewayProcessReady(gateway) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (gateway.diagnostics.includes("[gateway] ready")) return;
    if (gateway.exitCode !== null || gateway.signalCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`OPENCLAW_GATEWAY_READY_TIMEOUT\n${gateway.diagnostics}`);
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

async function waitForRuntimeHealth(runtimeStorage) {
  let content = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    content = await readFile(join(runtimeStorage, "runtime-health.json"), "utf8")
      .catch(() => "");
    if (content.length > 0) {
      const health = JSON.parse(content);
      if (health.status === "pass") return health;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`RUNTIME_HEALTH_PASS_TIMEOUT\n${content}`);
}

async function waitForRuntimeHealthFailure(runtimeStorage, reasonPattern) {
  let content = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    content = await readFile(join(runtimeStorage, "runtime-health.json"), "utf8")
      .catch(() => "");
    if (content.length > 0) {
      const health = JSON.parse(content);
      if (
        health.status === "fail"
        && health.reasonCodes.some((reason) => reasonPattern.test(reason))
      ) {
        return health;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`RUNTIME_HEALTH_FAILURE_TIMEOUT\n${content}`);
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

async function verifyExactHostBeforeAgentRunGate(environment, modelRequests) {
  const requestStart = modelRequests.length;
  await run(
    "openclaw",
    [
      "agent",
      "--agent",
      "main",
      "--session-key",
      "agent:main:telegram:direct:+15555550123",
      "--channel",
      "telegram",
      "--to",
      "+15555550123",
      "--message",
      "ROUTER_INVALID",
      "--json",
      "--timeout",
      "15",
    ],
    { env: environment },
  );
  const requests = modelRequests.slice(requestStart).filter((request) =>
    Array.isArray(request.messages));
  assert.equal(
    requests.length,
    1,
    "a Router rejection must stop before the exact Host sends the final Agent model request",
  );
  assert.match(
    JSON.stringify(requests[0]?.messages),
    /Return exactly one Router Result JSON object\./,
  );
}

async function runHostSuccessors(environment, evidencePath, port, token) {
  const baselineEvidence = await readProbeEvidence(evidencePath, 0);
  const baselineAgentEnds = baselineEvidence.filter(
    (entry) => entry.hook === "agent_end",
  ).length;
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
  await readProbeEvidence(evidencePath, baselineAgentEnds + 1);
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
  await readProbeEvidence(evidencePath, baselineAgentEnds + 2);
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
    evidence = await readProbeEvidence(evidencePath, baselineAgentEnds + 3);
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
        entry.hook === "agent_end" && [commandRun.runId, uiRun.runId].includes(entry.runId)
      )
      .every((entry) => entry.success && entry.activeRunCount === 0),
    true,
  );
  const memoryTool = evidence.find(
    (entry) => entry.runId === uiRun.runId && entry.hook === "after_tool_call",
  );
  assert.equal(memoryTool?.toolName, "synthetic_memory");
  assert.equal(typeof memoryTool?.toolCallId, "string");
  const confirmation = evidence.find(
    (entry) => entry.hook === "gateway_start_confirmation",
  );
  assert.equal(confirmation?.dispatch.matched, true, evidenceDiagnostic);
  assert.equal(confirmation?.dispatch.handled, true, evidenceDiagnostic);
  assert.equal(confirmation?.dispatch.duplicate, false, evidenceDiagnostic);
  assert.deepEqual(confirmation?.replies, [
    "buttons-cleared",
    "AUTHORITY_CANDIDATE_ACCEPTED",
  ]);
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

async function snapshotFiles(directory, relativeDirectory = "") {
  const entries = await readdir(join(directory, relativeDirectory), { withFileTypes: true });
  const snapshots = await Promise.all(entries
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(async (entry) => {
      const relativePath = join(relativeDirectory, entry.name);
      if (entry.isDirectory()) return snapshotFiles(directory, relativePath);
      if (!entry.isFile()) return [];
      return [{
        path: relativePath,
        checksum: checksum(await readFile(join(directory, relativePath))),
      }];
    }));
  return snapshots.flat().sort((left, right) => left.path.localeCompare(right.path));
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

async function verifyTelegramConfirmationGateway(runtime) {
  let sequence = 0;
  const service = new runtime.CandidateAdmissionService({
    now: () => new Date("2026-08-14T01:00:00.000Z"),
    createId: (kind) => `${kind}-packed-${++sequence}`,
    createRoutingToken: () => "abcdefghijklmnopqrstuvwxyzABCDEFGH012345678",
    authorityHead: { getCurrent: () => null },
  });
  const authorization = service.authorizeDiscovery({
    instanceId: "instance-packed",
    scope: {
      candidateTypes: ["semantic"],
      sourceRefs: ["source-packed"],
    },
    grantedBy: "owner-packed",
    expiresAt: "2026-08-14T02:00:00.000Z",
  });
  const candidate = service.createCandidate({
    authorizationId: authorization.authorization_id,
    candidateType: "semantic",
    stableId: "semantic-packed",
    baseAuthorityVersion: null,
    baseChecksum: null,
    baseContent: null,
    content: { claim: "Packed callback claim." },
    sourceMap: [{ sourceRef: "source-packed", contentPath: "body" }],
  });
  let presentation;
  const confirmation = await runtime.presentTelegramConfirmation({
    service,
    input: {
      authorizationId: authorization.authorization_id,
      candidateId: candidate.candidate_id,
      revision: candidate.revision,
      channel: "telegram",
    },
    presentation: {
      async present(input) {
        presentation = input;
        return {
          schema_version: "cognitive-runtime.approval-message-reference/v2",
          provider: "telegram",
          instance_id: "instance-packed",
          account_id: "account-packed",
          conversation_id: "conversation-packed",
          message_id: "42",
        };
      },
    },
  });
  assert.equal(confirmation.status, "presented");
  assert.match(presentation.text, /Complete Candidate:/);
  const [accept] = presentation.actions;
  assert.ok(accept);
  const registrations = [];
  runtime.registerTelegramConfirmationGateway({
    api: {
      registerInteractiveHandler(registration) {
        registrations.push(registration);
      },
    },
    service,
    hostVersion: "2026.6.34",
  });
  const registration = registrations[0];
  assert.ok(registration);
  const replies = [];
  await registration.handler({
    channel: "telegram",
    accountId: "account-packed",
    conversationId: "conversation-packed",
    senderId: "owner-packed",
    auth: { isAuthorizedSender: true },
    callback: {
      namespace: runtime.TELEGRAM_CONFIRMATION_NAMESPACE,
      payload: accept.callbackData.split(":").slice(1).join(":"),
      messageId: 42,
    },
    respond: {
      async clearButtons() {
        replies.push("buttons-cleared");
      },
      async reply({ text }) {
        replies.push(text);
      },
    },
  });
  assert.deepEqual(replies, [
    "buttons-cleared",
    "AUTHORITY_CANDIDATE_ACCEPTED",
  ]);
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
  await verifyTelegramConfirmationGateway(runtime);
}

async function packInstallFitness({ root, environment }) {
  const configuredRoot = process.env.STELLA_FITNESS_PACKAGE_ROOT?.trim();
  const packageRoot = configuredRoot === undefined || configuredRoot.length === 0
    ? fileURLToPath(new URL("../../../Stella-Fitness/", import.meta.url))
    : configuredRoot;
  const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(packageJson.name, "@tower1229/stella-fitness");
  const { stdout: sourceRevisionOutput } = await run(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: packageRoot, env: environment },
  );
  const sourceRevision = sourceRevisionOutput.trim();
  const expectedSourceRevision = process.env.STELLA_FITNESS_EXPECTED_REVISION?.trim();
  if (expectedSourceRevision !== undefined && expectedSourceRevision.length > 0) {
    assert.equal(sourceRevision, expectedSourceRevision);
  }
  const { stdout: packOutput } = await run(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", root],
    { cwd: packageRoot, env: environment },
  );
  const [pack] = JSON.parse(packOutput);
  await run(
    "openclaw",
    ["plugins", "install", `npm-pack:${join(root, pack.filename)}`],
    { env: environment },
  );
  const { stdout: inspectOutput } = await run(
    "openclaw",
    ["plugins", "inspect", "stella-fitness", "--runtime", "--json"],
    { env: environment },
  );
  const inspection = parseJsonOutput(inspectOutput);
  assert.equal(inspection.plugin.status, "loaded");
  const pluginRoot = dirname(dirname(inspection.plugin.source));
  const installedPackage = JSON.parse(await readFile(join(pluginRoot, "package.json"), "utf8"));
  assert.equal(installedPackage.name, "@tower1229/stella-fitness");
  assert.equal(installedPackage.version, packageJson.version);
  return {
    pluginRoot,
    packageRoot,
    sourceRevision,
    installSpec: `npm-pack:${join(root, pack.filename)}`,
  };
}

async function publishInitialFitnessProjection({
  pluginRoot,
  openclawConfig,
  fitnessDataDirectory,
}) {
  const scenario = await import(
    pathToFileURL(join(pluginRoot, "dist", "scenario", "harness.js")).href
  );
  const fitness = await import(
    pathToFileURL(join(pluginRoot, "dist", "plugin.js")).href
  );
  const harness = scenario.createScenarioHarness({
    extractionRuntime: {
      async extract() {
        throw new Error("SYNTHETIC_EXTRACTION_MUST_NOT_RUN");
      },
    },
    personalDataDirectory: () => fitnessDataDirectory,
    runtimeDirectory: () => join(fitnessDataDirectory, "..", "runtime"),
    preflight: () => ({ readiness: "READY", reasons: [] }),
  });
  const recorded = await harness.recordBodyWeight({
    text: "2026-08-24T00:00:00Z body weight 68.4 kg",
    receivedAt: "2026-08-24T00:00:00.000Z",
    source: { channel: "synthetic", messageId: "fitness-f1" },
  });
  assert.equal(recorded.status, "recorded");
  const publication = await fitness.publishFitnessContextProjection({
    openclawConfig,
    generatedAt: "2026-08-24T00:01:00.000Z",
  });
  assert.equal(publication.status, "published");
  return { fitness, harness, recorded, publication };
}

async function compilePackedBinding(runtime, runtimeConfig, apiConfig, ownerId) {
  const layout = await runtime.resolvePersonalDataLocator({
    apiConfig,
    runtimeInstanceId: runtimeConfig.instance_id,
  });
  const exchange = new runtime.FileProjectionExchange({
    layout,
    instanceId: runtimeConfig.instance_id,
    ownerId,
  });
  return new runtime.FileBindingCompiler({
    domainProjectionReader: {
      async read(domainId) {
        assert.equal(domainId, "fitness");
        const projection = await exchange.readStellaProjection("fitness_history");
        return runtime.generationDomainIdentity(domainId, projection);
      },
    },
  }).compile({
    config: runtimeConfig,
    hostVersion: "2026.6.34",
    nodeVersion: process.versions.node,
  });
}

async function verifyExactHostGenerationConsumption({
  runtime,
  runtimeConfig,
  sourceRevision,
  environment,
  evidencePath,
  modelRequests,
  port,
  token,
  restartGateway,
  apiConfig,
}) {
  await restartGateway();
  await waitForDeepGatewayProbe(environment);
  const priorBinding = await new runtime.FileBindingCompiler().compile({
    config: runtimeConfig,
    hostVersion: "2026.6.34",
    nodeVersion: process.versions.node,
  });
  assert.equal(priorBinding.authorityRevision, sourceRevision);
  assert.equal(
    priorBinding.context.semanticClaims.some((claim) =>
      claim.id === "sem-packed-accepted"),
    false,
  );
  const { stdout: publicationOutput } = await run(
    "openclaw",
    [
      "gateway",
      "call",
      "cognitive-probe.publish-accepted",
      "--url",
      `ws://127.0.0.1:${port}`,
      "--token",
      token,
      "--json",
      "--timeout",
      "120000",
    ],
    { env: environment, timeout: 180_000 },
  );
  const publicationResponse = parseJsonOutput(publicationOutput);
  const publication = publicationResponse.result ?? publicationResponse;
  assert.equal(publication.publicationStatus, "Published");
  assert.notEqual(publication.sourceRevision, sourceRevision);
  const pointerBeforeSync = JSON.parse(await readFile(
    join(runtimeConfig.runtime_storage, "active-generation.json"),
    "utf8",
  ));
  assert.equal(pointerBeforeSync.source_revision, sourceRevision);

  const { stdout: syncOutput, stderr: syncError } = await run(
    "openclaw",
    [
      "cognitive",
      "sync",
      "--revision",
      publication.sourceRevision,
      "--json",
    ],
    { env: environment, timeout: 180_000 },
  );
  const activated = parseJsonOutput(syncOutput.length > 0 ? syncOutput : syncError);
  assert.equal(activated.operation, "sync");
  assert.equal(activated.source_revision, publication.sourceRevision);
  const receipt = JSON.parse(await readFile(activated.receipt_path, "utf8"));
  assert.equal(receipt.index_evidence.deep_status, "pass");
  assert.match(receipt.index_evidence.search_sentinel_checksum, /^sha256:[a-f0-9]{64}$/);
  assert.match(receipt.index_evidence.get_sentinel_checksum, /^sha256:[a-f0-9]{64}$/);
  await restartGateway();
  await waitForDeepGatewayProbe(environment);
  await waitForRuntimeHealth(runtimeConfig.runtime_storage);

  const result = await run(
    "openclaw",
    [
      "agent",
      "--agent",
      "main",
      "--channel",
      "telegram",
      "--to",
      "+15555550123",
      "--message",
      "ELIGIBLE_GENERATION_RUN",
      "--json",
      "--timeout",
      "15",
    ],
    { env: environment },
  );
  assert.match(result.stdout, /Synthetic host response/);
  const evidence = await readProbeEvidence(evidencePath, 1);
  const eligible = evidence.find((entry) => entry.hook === "eligible_generation_run");
  assert.ok(eligible, JSON.stringify(evidence, null, 2));
  assert.equal(eligible.agentId, "main");
  assert.equal(eligible.trigger, "user");
  assert.equal(eligible.messageProvider, "telegram");
  assert.equal(eligible.senderId, "+15555550123");
  assert.equal(eligible.chatId, "+15555550123");
  assert.ok(modelRequests.some((request) =>
    Array.isArray(request.messages)
    && JSON.stringify(request.messages).includes("[semantic:sem-synthetic-claim]")
    && JSON.stringify(request.messages).includes("Synthetic claims can be tested.")),
  "next Eligible Run did not preserve the prior activated semantic claim");
  assert.ok(modelRequests.some((request) =>
    Array.isArray(request.messages)
    && JSON.stringify(request.messages).includes("[semantic:sem-packed-accepted]")
    && JSON.stringify(request.messages).includes(
      "Packed approval reaches the next eligible Run.",
    )),
  "next Eligible Run did not consume the published semantic claim");
  const binding = await compilePackedBinding(
    runtime,
    runtimeConfig,
    apiConfig,
    "packed-acceptance-binding-reader",
  );
  assert.equal(binding.syncGeneration, activated.sync_generation);
  assert.equal(binding.authorityRevision, publication.sourceRevision);
  return { activated, publication };
}

async function verifyFitnessF2Replacement({
  runtime,
  runtimeConfig,
  apiConfig,
  initialFitness,
  authorityRevision,
  environment,
  modelServer,
  restartGateway,
}) {
  const pointerPath = join(runtimeConfig.runtime_storage, "active-generation.json");
  const g1 = JSON.parse(await readFile(pointerPath, "utf8"));
  assert.equal(g1.schema_version, "cognitive-runtime.active-generation-pointer/v3");
  assert.equal(g1.authority.revision, authorityRevision);
  assert.equal(g1.domains[0].projection_revision, initialFitness.publication.projectionRevision);

  const corrected = await initialFitness.harness.correctBodyWeight({
    replacesObservationId: initialFitness.recorded.observation.id,
    text: "correct body weight to 67.9 kg",
    receivedAt: "2026-08-24T00:02:00.000Z",
  });
  assert.equal(corrected.status, "recorded");
  const f2 = await initialFitness.fitness.publishFitnessContextProjection({
    openclawConfig: apiConfig,
    generatedAt: "2026-08-24T00:03:00.000Z",
  });
  assert.notEqual(f2.projectionRevision, initialFitness.publication.projectionRevision);
  assert.equal(f2.asOf, "2026-08-24T00:02:00.000Z");

  const layout = await runtime.resolvePersonalDataLocator({
    apiConfig,
    runtimeInstanceId: runtimeConfig.instance_id,
  });
  const activeF2 = await new runtime.FileProjectionExchange({
    layout,
    instanceId: runtimeConfig.instance_id,
    ownerId: "packed-fitness-f2-reader",
  }).readStellaProjection("fitness_history");
  assert.equal(activeF2.projectionRevision, f2.projectionRevision);
  const [fitnessPayload] = activeF2.payloads;
  assert.ok(fitnessPayload);
  assert.match(fitnessPayload.stableId, /^fitness-history-/);

  const { stdout, stderr } = await run(
    "openclaw",
    ["cognitive", "sync", "--revision", authorityRevision, "--json"],
    { env: environment, timeout: 180_000 },
  );
  const activated = parseJsonOutput(stdout.length > 0 ? stdout : stderr);
  assert.equal(activated.source_revision, authorityRevision);
  assert.notEqual(activated.sync_generation, g1.generation_id);
  const g2 = JSON.parse(await readFile(pointerPath, "utf8"));
  assert.equal(g2.authority.revision, authorityRevision);
  assert.equal(g2.domains[0].projection_revision, f2.projectionRevision);
  const receipt = JSON.parse(await readFile(activated.receipt_path, "utf8"));
  assert.equal(receipt.domains[0].projection_revision, f2.projectionRevision);
  assert.equal(receipt.index_evidence.fitness.projection_revision, f2.projectionRevision);
  assert.equal(receipt.index_evidence.fitness.previous_revision,
    initialFitness.publication.projectionRevision);
  assert.equal(receipt.index_evidence.fitness.previous_stable_id_hits, 0);
  assert.equal(receipt.index_evidence.fitness.previous_text_sentinel_hits, 0);
  assert.equal(receipt.index_evidence.fitness.previous_source_reference_hits, 0);

  await restartGateway();
  await waitForDeepGatewayProbe(environment);
  await waitForRuntimeHealth(runtimeConfig.runtime_storage);
  const requestStart = modelServer.requests.length;
  const result = await run(
    "openclaw",
    [
      "agent",
      "--agent",
      "main",
      "--channel",
      "telegram",
      "--to",
      "+15555550123",
      "--message",
      "FITNESS_F2_RUN ELIGIBLE_GENERATION_RUN",
      "--json",
      "--timeout",
      "15",
    ],
    { env: environment },
  );
  assert.match(result.stdout, /Synthetic host response/);
  const finalRequests = modelServer.requests.slice(requestStart).filter((request) =>
    Array.isArray(request.messages)
    && JSON.stringify(request.messages).includes("67.9"));
  assert.equal(finalRequests.length, 1,
    "Stella next Eligible Run did not consume the exact F2 projection");
  assert.equal(JSON.stringify(finalRequests[0].messages).includes("68.4"), false,
    "the final model request retained the replaced F1 Fitness value");
  return { f2, activated };
}

async function verifyPackedHostNegativeMatrices(environment, port, token, modelRequests) {
  const callProbe = async (method) => {
    const { stdout } = await run(
      "openclaw",
      [
        "gateway",
        "call",
        method,
        "--url",
        `ws://127.0.0.1:${port}`,
        "--token",
        token,
        "--json",
        "--timeout",
        "30000",
      ],
      { env: environment, timeout: 40_000 },
    );
    const response = parseJsonOutput(stdout);
    return response.result ?? response;
  };

  const requestStart = modelRequests.length;
  assert.deepEqual(await callProbe("cognitive-probe.fail-closed-matrix"), {
    missingRunId: "RUN_ID_REQUIRED",
    inputLimit: "ROUTER_INPUT_LIMIT_EXCEEDED",
    routerInvalid: "ROUTER_NON_JSON_OUTPUT",
    routerTimeout: "ROUTER_TIMEOUT",
    scratchCapacity: "RUN_SCRATCH_CAPACITY",
    lifecycleInvalid: "RUN_LIFECYCLE_INVALIDATED",
    runtimeException: "RUNTIME_FAILURE",
  });
  assert.equal(
    modelRequests.slice(requestStart).some((request) =>
      JSON.stringify(request).includes("FINAL_HOST_MODEL")),
    false,
    "a blocked packed Host matrix case reached its final model request",
  );
  assert.deepEqual(await callProbe("cognitive-probe.admission-negative-matrix"), {
    ordinary: "DISCOVERY_AUTHORIZATION_NOT_ACTIVE",
    ended: "CONFIRMATION_ROUTING_TOKEN_INVALID",
    unsupported: "redirect_required",
    llmText: "CONFIRMATION_CALLBACK_INVALID",
    nonAcceptedReceiptCount: 0,
    authorityRevisionUnchanged: true,
    authorityCommits: 0,
    changeSetPublications: 0,
    mismatchReasons: {
      checksum: "PUBLICATION_APPROVAL_MISMATCH",
      base: "PUBLICATION_APPROVAL_MISMATCH",
      revision: "PUBLICATION_APPROVAL_MISMATCH",
    },
    mismatchedReceiptsUnconsumed: true,
  });
}

async function verifyPackedUnsmokedHostGates({
  runtime,
  pluginRoot,
  runtimeConfig,
  authorityDirectory,
  environment,
  configPath,
  port,
  token,
  modelRequests,
  restartGateway,
  readGatewayDiagnostics,
}) {
  const matrixPath = join(pluginRoot, "compatibility", "openclaw.json");
  const originalMatrix = await readFile(matrixPath, "utf8");
  const matrix = JSON.parse(originalMatrix);
  const originalConfig = await readFile(configPath, "utf8");
  const pointerPath = join(runtimeConfig.runtime_storage, "active-generation.json");
  const originalPointer = await readFile(pointerPath, "utf8");
  const receiptsDirectory = join(runtimeConfig.runtime_storage, "activation-receipts");
  const readReceipts = async () => Promise.all(
    (await readdir(receiptsDirectory)).sort().map(async (name) => ({
      name,
      content: await readFile(join(receiptsDirectory, name), "utf8"),
    })),
  );
  const originalReceipts = await readReceipts();
  const originalBinding = await compilePackedBinding(
    runtime,
    runtimeConfig,
    JSON.parse(originalConfig),
    "packed-unsmoked-original-reader",
  );
  await writeFile(join(authorityDirectory, "unsmoked-host-probe.txt"), "unsmoked\n");
  const targetRevision = await commitAuthorityChanges(
    authorityDirectory,
    "acceptance: unsmoked host gate",
  );
  let recoveredReconciliation;

  try {
    await writeFile(matrixPath, JSON.stringify({ ...matrix, hosts: [] }));
    await restartGateway();
    await run(
      "openclaw",
      [
        "gateway",
        "call",
        "cognitive-runtime.reconcile",
        "--url",
        `ws://127.0.0.1:${port}`,
        "--token",
        token,
        "--json",
        "--timeout",
        "120000",
      ],
      { env: environment },
    );
    const incompatibleHealth = await waitForRuntimeHealthFailure(
      runtimeConfig.runtime_storage,
      /INCOMPATIBLE_HOST/,
    );
    assert.deepEqual(incompatibleHealth.reasonCodes, ["INCOMPATIBLE_HOST"]);
    let startupDiagnostics = "";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      startupDiagnostics = readGatewayDiagnostics();
      if (/"reasonCode":"INCOMPATIBLE_HOST"/.test(startupDiagnostics)) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.match(
      startupDiagnostics,
      /"reasonCode":"INCOMPATIBLE_HOST"/,
      "the unsmoked Host did not reject startup recovery before admission",
    );

    const requestStart = modelRequests.length;
    await run(
      "openclaw",
      [
        "agent",
        "--agent",
        "main",
        "--channel",
        "telegram",
        "--to",
        "+15555550123",
        "--message",
        "ELIGIBLE_GENERATION_RUN",
        "--json",
        "--timeout",
        "15",
      ],
      { env: environment },
    );
    assert.deepEqual(
      modelRequests.slice(requestStart),
      [],
      "an engine-compatible Host absent from the packed matrix reached the model",
    );

    try {
      await run(
        "openclaw",
        ["cognitive", "sync", "--revision", targetRevision, "--json"],
        { env: environment, timeout: 180_000 },
      );
      assert.fail("unsmoked packed Host unexpectedly entered sync");
    } catch (error) {
      assert.match(
        [error?.message, error?.stdout, error?.stderr].filter(Boolean).join("\n"),
        /INCOMPATIBLE_HOST/,
      );
    }
    assert.equal(await readFile(configPath, "utf8"), originalConfig);
    assert.equal(await readFile(pointerPath, "utf8"), originalPointer);
    assert.deepEqual(await readReceipts(), originalReceipts);
  } finally {
    await writeFile(matrixPath, originalMatrix);
    await restartGateway();
    await waitForDeepGatewayProbe(environment);
    const { stdout } = await run(
      "openclaw",
      [
        "gateway",
        "call",
        "cognitive-runtime.reconcile",
        "--url",
        `ws://127.0.0.1:${port}`,
        "--token",
        token,
        "--json",
        "--timeout",
        "120000",
      ],
      { env: environment, timeout: 180_000 },
    );
    const response = parseJsonOutput(stdout);
    recoveredReconciliation = response.result ?? response;
  }

  assert.equal(recoveredReconciliation.status, "pass");
  assert.deepEqual(recoveredReconciliation.reasonCodes, []);
  const recoveredHealth = await waitForRuntimeHealth(runtimeConfig.runtime_storage);
  assert.deepEqual(recoveredHealth.reasonCodes, []);
  assert.equal(await readFile(matrixPath, "utf8"), originalMatrix);
  assert.equal(await readFile(configPath, "utf8"), originalConfig);
  assert.equal(await readFile(pointerPath, "utf8"), originalPointer);
  assert.deepEqual(await readReceipts(), originalReceipts);

  const recoveredBinding = await compilePackedBinding(
    runtime,
    runtimeConfig,
    JSON.parse(originalConfig),
    "packed-unsmoked-recovered-reader",
  );
  assert.deepEqual(recoveredBinding, originalBinding);
  const requestStart = modelRequests.length;
  const recoveredRun = await run(
    "openclaw",
    [
      "agent",
      "--agent",
      "main",
      "--channel",
      "telegram",
      "--to",
      "+15555550123",
      "--message",
      "ELIGIBLE_GENERATION_RUN",
      "--json",
      "--timeout",
      "15",
    ],
    { env: environment },
  );
  assert.match(recoveredRun.stdout, /Synthetic host response/);
  const recoveredRequests = modelRequests.slice(requestStart);
  assert.ok(recoveredRequests.some((request) =>
    JSON.stringify(request).includes("[semantic:sem-synthetic-claim]")),
  "the recovered Host could not retrieve the prior Generation");
  assert.ok(recoveredRequests.some((request) =>
    JSON.stringify(request).includes("[semantic:sem-packed-accepted]")),
  "the recovered Host could not retrieve the active published Generation");
}

async function verifyExactHostFailureRecovery({
  runtime,
  runtimeConfig,
  authorityDirectory,
  environment,
  configPath,
  modelServer,
  restartGateway,
  interruptGateway,
}) {
  const activePointer = JSON.parse(await readFile(
    join(runtimeConfig.runtime_storage, "active-generation.json"),
    "utf8",
  ));
  const assertPriorRestored = async () => {
    await restartGateway();
    await waitForDeepGatewayProbe(environment);
    await waitForRuntimeHealth(runtimeConfig.runtime_storage);
    const pointer = JSON.parse(await readFile(
      join(runtimeConfig.runtime_storage, "active-generation.json"),
      "utf8",
    ));
    assert.deepEqual(pointer, activePointer);
    const binding = await compilePackedBinding(
      runtime,
      runtimeConfig,
      JSON.parse(await readFile(configPath, "utf8")),
      "packed-failure-recovery-reader",
    );
    assert.equal(binding.syncGeneration, activePointer.generation_id);
  };
  const commitFailureRevision = async (reason) => {
    await writeFile(join(authorityDirectory, "failure-probe.txt"), `${reason}\n`);
    return commitAuthorityChanges(authorityDirectory, `acceptance: ${reason}`);
  };
  const runFailedSync = async (revision, reasonPattern) => {
    try {
      await run(
        "openclaw",
        ["cognitive", "sync", "--revision", revision, "--json"],
        { env: environment, timeout: 180_000 },
      );
      assert.fail("expected cognitive sync to fail");
    } catch (error) {
      const output = [error?.message, error?.stdout, error?.stderr]
        .filter((value) => typeof value === "string")
        .join("\n");
      assert.match(output, reasonPattern);
    }
  };

  const configRevision = await commitFailureRevision("host-config-mutation");
  await chmod(dirname(configPath), 0o500);
  try {
    await runFailedSync(configRevision, /EACCES|permission denied/i);
  } finally {
    await chmod(dirname(configPath), 0o700);
  }
  await assertPriorRestored();

  const indexRevision = await commitFailureRevision("host-index");
  const failureCountBefore = modelServer.control.embeddingFailureCount;
  modelServer.control.embeddingMode = "fail";
  try {
    await runFailedSync(indexRevision, /OPENCLAW_DEEP_STATUS_FAILED/);
  } finally {
    modelServer.control.embeddingMode = "normal";
  }
  assert.ok(modelServer.control.embeddingFailureCount > failureCountBefore);
  await assertPriorRestored();

  const searchRevision = await commitFailureRevision("search-sentinel");
  const searchConfigText = await readFile(configPath, "utf8");
  const searchConfig = JSON.parse(searchConfigText);
  searchConfig.agents.list[0].memorySearch.query.minScore = 0.9;
  searchConfig.agents.list[0].memorySearch.query.hybrid = { enabled: false };
  searchConfig.agents.list[0].memorySearch.cache = { enabled: false };
  await writeFile(configPath, `${JSON.stringify(searchConfig, null, 2)}\n`, { mode: 0o600 });
  await restartGateway();
  await waitForRuntimeHealth(runtimeConfig.runtime_storage);
  modelServer.control.embeddingMode = "search-miss";
  try {
    await runFailedSync(searchRevision, /OPENCLAW_SEARCH_SENTINEL_MISSING/);
  } finally {
    modelServer.control.embeddingMode = "normal";
    await writeFile(configPath, searchConfigText, { mode: 0o600 });
  }
  await assertPriorRestored();

  const interruptionRevision = await commitFailureRevision("process-interruption");
  let interruption;
  const interrupted = new Promise((resolve, reject) => {
    modelServer.control.onEmbeddingRequest = () => {
      modelServer.control.onEmbeddingRequest = undefined;
      interruption = interruptGateway().then(resolve, reject);
    };
  });
  await runFailedSync(
    interruptionRevision,
    /ECONNRESET|ECONNREFUSED|socket.*closed|gateway.*closed|terminated/i,
  );
  await interrupted;
  await interruption;
  await assertPriorRestored();
}

async function verifyExactHostDriftGates({
  runtimeConfig,
  environment,
  modelServer,
  port,
  token,
}) {
  const activePointer = JSON.parse(await readFile(
    join(runtimeConfig.runtime_storage, "active-generation.json"),
    "utf8",
  ));
  const receiptPath = join(
    runtimeConfig.runtime_storage,
    "activation-receipts",
    `${activePointer.activation_receipt_id}.json`,
  );
  const originalReceipt = await readFile(receiptPath, "utf8");
  const reconcileGateway = async () => {
    await run(
      "openclaw",
      [
        "gateway",
        "call",
        "cognitive-runtime.reconcile",
        "--url",
        `ws://127.0.0.1:${port}`,
        "--token",
        token,
        "--json",
        "--timeout",
        "120000",
      ],
      { env: environment },
    );
  };
  const callProbe = async (method) => {
    await run(
      "openclaw",
      [
        "gateway",
        "call",
        method,
        "--url",
        `ws://127.0.0.1:${port}`,
        "--token",
        token,
        "--json",
        "--timeout",
        "120000",
      ],
      { env: environment },
    );
  };
  const assertRunGated = async (reasonPattern, options = {}) => {
    if (options.restart !== false) await restartGateway();
    await waitForRuntimeHealthFailure(runtimeConfig.runtime_storage, reasonPattern);
    const requestStart = modelServer.requests.length;
    await run(
      "openclaw",
      [
        "agent",
        "--agent",
        "main",
        "--channel",
        "telegram",
        "--to",
        "+15555550123",
        "--message",
        "ELIGIBLE_GENERATION_RUN",
        "--json",
        "--timeout",
        "15",
      ],
      { env: environment },
    );
    const requestsAfterGate = modelServer.requests.slice(requestStart);
    assert.equal(
      requestsAfterGate.some((request) =>
        JSON.stringify(request).includes("[semantic:sem-packed-accepted]")),
      false,
    );
    const agentModelRequests = requestsAfterGate.filter((request) =>
      Array.isArray(request.messages));
    assert.deepEqual(
      agentModelRequests,
      [],
      "a gated Eligible Run must not reach the final Agent model or produce a native answer",
    );
  };

  const staleReceipt = JSON.parse(originalReceipt);
  staleReceipt.generation_id = `generation-${"f".repeat(64)}`;
  await writeFile(receiptPath, JSON.stringify(staleReceipt));
  await reconcileGateway();
  await assertRunGated(/STALE_RECEIPT/, { restart: false });
  await writeFile(receiptPath, originalReceipt);
  await reconcileGateway();
  await waitForRuntimeHealth(runtimeConfig.runtime_storage);

  const configDriftReceipt = JSON.parse(originalReceipt);
  configDriftReceipt.host_config_checksum = `sha256:${"e".repeat(64)}`;
  await writeFile(receiptPath, JSON.stringify(configDriftReceipt));
  await reconcileGateway();
  await assertRunGated(/CONFIG_DRIFT/, { restart: false });
  await writeFile(receiptPath, originalReceipt);
  await reconcileGateway();
  await waitForRuntimeHealth(runtimeConfig.runtime_storage);

  await callProbe("cognitive-probe.remove-retrieval-paths");
  await reconcileGateway();
  await assertRunGated(/INDEX_DRIFT/, { restart: false });
  await callProbe("cognitive-probe.restore-retrieval-paths");
  await reconcileGateway();
  await waitForRuntimeHealth(runtimeConfig.runtime_storage);
}

test("packed runtime passes the exact OpenClaw host smoke and restores configuration", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "stella-runtime-openclaw-")));
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
  const personalDataRepository = join(root, "personal-data");
  const personalDataRoot = join(personalDataRepository, "stella");
  const authorityDirectory = join(personalDataRoot, "authority");
  const fitnessDataDirectory = join(personalDataRoot, "fitness");
  const projectionRoot = join(personalDataRoot, "projections");
  await mkdir(join(workspace, "memory"), { recursive: true });
  await writeFile(join(workspace, "MEMORY.md"), "# Synthetic memory\n", "utf8");
  for (const directory of [
    personalDataRepository,
    personalDataRoot,
    fitnessDataDirectory,
    projectionRoot,
    join(projectionRoot, "fitness"),
    join(projectionRoot, "stella"),
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
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
      list: [{
        id: "main",
        workspace,
        model: { primary: "synthetic/synthetic-model" },
        memorySearch: {
          enabled: true,
          sources: ["memory"],
          provider: "openai-compatible",
          model: "synthetic-embedding",
          fallback: "none",
          remote: {
            baseUrl: `http://127.0.0.1:${modelPort}/v1`,
            apiKey: providerKey,
            batch: { enabled: false },
          },
          sync: { onSessionStart: false, onSearch: false, watch: false },
          query: { minScore: 0 },
        },
      }, {
        id: "fitness",
        workspace: join(root, "workspace-fitness"),
        model: { primary: "synthetic/synthetic-model" },
        memorySearch: { enabled: false },
      }],
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
  let fitnessInstalled = false;
  let probeInstalled = false;
  let gateway;

  try {
    const { stdout: versionOutput } = await run("openclaw", ["--version"], {
      env: environment,
    });
    assert.match(versionOutput, /2026\.6\.34 \(5c38f99\)/);

    const registryInstallSpec = process.env.STELLA_RUNTIME_INSTALL_SPEC?.trim();
    const repositoryPackage = JSON.parse(
      await readFile(new URL("package.json", repositoryRoot), "utf8"),
    );
    const expectedInstallVersion = process.env.STELLA_RUNTIME_EXPECTED_VERSION?.trim()
      || repositoryPackage.version;
    const expectedRegistryIntegrity = process.env.STELLA_RUNTIME_EXPECTED_INTEGRITY?.trim();
    let installSpec;
    if (registryInstallSpec === undefined || registryInstallSpec.length === 0) {
      const { stdout: packOutput } = await run(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", root],
        { cwd: repositoryRoot, env: environment },
      );
      const [pack] = JSON.parse(packOutput);
      installSpec = `npm-pack:${join(root, pack.filename)}`;
    } else {
      assert.ok(expectedRegistryIntegrity, "registry smoke requires exact expected integrity");
      const { stdout: publishedIntegrity } = await run(
        "npm",
        ["view", registryInstallSpec, "dist.integrity"],
        { env: environment },
      );
      assert.equal(publishedIntegrity.trim(), expectedRegistryIntegrity);
      installSpec = registryInstallSpec;
    }
    await run(
      "openclaw",
      ["plugins", "install", installSpec],
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
    assert.deepEqual(
      inspection.plugin.configJsonSchema.properties.runtime.properties.host
        .properties.eligible_scope.const,
      ["private_main_session"],
    );
    const pluginRoot = dirname(dirname(dirname(inspection.plugin.source)));
    const installedPackage = JSON.parse(
      await readFile(join(pluginRoot, "package.json"), "utf8"),
    );
    assert.equal(installedPackage.name, "@tower1229/stella-cognitive-runtime");
    assert.equal(installedPackage.version, expectedInstallVersion);
    environment.STELLA_RUNTIME_PROBE_ROOT = pluginRoot;
    await verifyRejectedPathsAbsent(pluginRoot);
    const installedRuntime = await import(
      pathToFileURL(join(pluginRoot, "dist", "index.js")).href
    );
    const generationState = join(root, "generation-state");
    const runtimeStorage = join(root, "runtime-binding");
    await writeSyntheticAuthority(authorityDirectory);
    const sourceRevision = await commitSyntheticAuthority(authorityDirectory);
    await chmod(authorityDirectory, 0o700);
    const built = await installedRuntime.buildGeneration({
      authorityDirectory,
      stateDirectory: generationState,
      sourceRevision,
      packageVersion: installedPackage.version,
    });
    const state = installedRuntime.createStateManagementPort({
      stateRoot: runtimeStorage,
      instanceId: "instance-synthetic",
    });
    await state.initialize();
    state.close();
    const runtimeConfig = {
      schema_version: "cognitive-runtime.instance-runtime-config/v2",
      instance_id: "instance-synthetic",
      mode: "enforce",
      runtime_storage: runtimeStorage,
      generation_storage: join(generationState, "generations"),
      host: { agent_id: "main", eligible_scope: ["private_main_session"] },
      authority_owner: { provider: "telegram", actor_id: "+15555550123" },
      limits: { max_active_runs: 8, drain_timeout_ms: 60_000 },
      adapters: {
        authority_checkout: authorityDirectory,
        host_retrieval: "openclaw-memory",
      },
    };
    const manifestChecksum = `sha256:${checksum(
      await readFile(join(built.generationDirectory, "manifest.json")),
    )}`;
    const projectionChecksum = built.manifest.files.find(
      (file) => file.path === "projection-entries.json",
    ).checksum;
    await mkdir(join(runtimeStorage, "activation-receipts"), { recursive: true });
    await writeFile(join(runtimeStorage, "activation-receipts", "activation-synthetic.json"), JSON.stringify({
      schema_version: "cognitive-runtime.activation-receipt/v2",
      receipt_id: "activation-synthetic",
      instance_id: "instance-synthetic",
      generation_id: built.syncGeneration,
      source_revision: sourceRevision,
      manifest_checksum: manifestChecksum,
      projection_checksum: projectionChecksum,
      host_config_checksum: installedRuntime.calculateRuntimeConfigIdentityChecksum(runtimeConfig),
      index_evidence: {
        deep_status: "pass",
        search_sentinel_checksum: contractChecksum("3"),
        get_sentinel_checksum: contractChecksum("4"),
      },
      release_channel: "extended-stable",
      openclaw_version: "2026.6.34",
      node_version: process.versions.node,
      verified_at: "2026-08-17T00:00:00.000Z",
    }));
    await writeFile(join(runtimeStorage, "active-generation.json"), JSON.stringify({
      schema_version: "cognitive-runtime.active-generation-pointer/v2",
      instance_id: "instance-synthetic",
      generation_id: built.syncGeneration,
      source_revision: sourceRevision,
      manifest_checksum: manifestChecksum,
      activation_receipt_id: "activation-synthetic",
      activated_at: "2026-08-17T00:00:00.000Z",
    }));

    const compatibility = JSON.parse(
      await readFile(join(pluginRoot, "compatibility", "openclaw.json"), "utf8"),
    );
    assert.equal(compatibility.hosts[0].releaseChannel, "extended-stable");
    assert.equal(compatibility.hosts[0].openclawVersion, "2026.6.34");
    assert.deepEqual(
      compatibility.hosts[0].capabilityExpectations.typedHooks.hooks,
      [
        "before_agent_run",
        "before_prompt_build",
        "after_tool_call",
        "before_agent_finalize",
        "agent_end",
      ],
    );
    assert.deepEqual(
      compatibility.hosts[0].capabilityExpectations.telegramConfirmation,
      {
        status: "required",
        interface: "registerInteractiveHandler",
        outboundInterface: "runtime.channel.outbound.loadAdapter",
        context: [
          "accountId",
          "senderId",
          "conversationId",
          "messageId",
        ],
      },
    );

    const { stdout: selfCheckOutput } = await run(
      "openclaw",
      ["cognitive", "self-check"],
      { env: environment },
    );
    assert.deepEqual(parseJsonOutput(selfCheckOutput), {
      status: "ok",
      pluginId: "cognitive-runtime",
      compatibilityMatrixRow: {
        releaseChannel: "extended-stable",
        openclawVersion: "2026.6.34",
        nodeVersion: "24.18.0",
        evidence: "docs/evidence/openclaw-2026.6.34.md",
      },
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
        runtime: runtimeConfig,
        stella: {
          schema_version: "stella.personal-data-locator/v1",
          instance_id: runtimeConfig.instance_id,
          personal_data_repository: personalDataRepository,
        },
      },
    };
    const fitnessPackage = await packInstallFitness({ root, environment });
    fitnessInstalled = true;
    installedConfig.plugins.entries["stella-fitness"] = {
      ...installedConfig.plugins.entries["stella-fitness"],
      enabled: true,
      hooks: { allowConversationAccess: true },
      config: {
        dedicatedAgentId: "fitness",
        extraction: { provider: "synthetic", model: "synthetic-model" },
      },
    };
    const initialFitness = await publishInitialFitnessProjection({
      pluginRoot: fitnessPackage.pluginRoot,
      openclawConfig: installedConfig,
      fitnessDataDirectory,
    });
    assert.match(initialFitness.publication.projectionRevision, /^projection-[a-f0-9]{64}$/);
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
    const restartGateway = async () => {
      if (gateway !== undefined) await stopGateway(gateway);
      gateway = spawnGateway(port, token, environment);
      try {
        await waitForGatewayProcessReady(gateway);
      } catch (error) {
        throw new Error([
          error.stderr ?? String(error),
          `GATEWAY_DIAGNOSTICS=${gateway.diagnostics}`,
        ].join("\n"));
      }
    };
    const interruptGateway = async () => {
      if (gateway !== undefined) await stopGateway(gateway);
      gateway = undefined;
    };
    const g1 = await verifyExactHostGenerationConsumption({
      runtime: installedRuntime,
      runtimeConfig,
      sourceRevision,
      environment,
      evidencePath,
      modelRequests: modelServer.requests,
      port,
      token,
      restartGateway,
      apiConfig: installedConfig,
    });
    await verifyFitnessF2Replacement({
      runtime: installedRuntime,
      runtimeConfig,
      apiConfig: installedConfig,
      initialFitness,
      authorityRevision: g1.publication.sourceRevision,
      environment,
      modelServer,
      restartGateway,
    });
    const canonicalFitnessSnapshot = await snapshotFiles(fitnessDataDirectory);
    const verifiedProjectionSnapshot = await snapshotFiles(join(projectionRoot, "stella"));
    const expectedLocator = installedConfig.plugins.entries["cognitive-runtime"].config.stella;
    const assertConsumerArtifactsPreserved = async () => {
      assert.deepEqual(await snapshotFiles(fitnessDataDirectory), canonicalFitnessSnapshot);
      assert.deepEqual(
        await snapshotFiles(join(projectionRoot, "stella")),
        verifiedProjectionSnapshot,
      );
      return JSON.parse(await readFile(configPath, "utf8"));
    };
    const assertLocatorPreserved = async () => {
      const currentConfig = await assertConsumerArtifactsPreserved();
      assert.deepEqual(
        currentConfig.plugins?.entries?.["cognitive-runtime"]?.config?.stella,
        expectedLocator,
      );
      return currentConfig;
    };

    await stopGateway(gateway);
    gateway = undefined;
    await run("openclaw", ["plugins", "disable", "stella-fitness"], {
      env: environment,
    });
    await assertLocatorPreserved();
    await run("openclaw", ["plugins", "enable", "stella-fitness"], {
      env: environment,
    });
    await assertLocatorPreserved();

    await run(
      "openclaw",
      ["plugins", "uninstall", "cognitive-runtime", "--force"],
      { env: environment },
    );
    runtimeInstalled = false;
    const afterRuntimeUninstall = await assertConsumerArtifactsPreserved();
    assert.equal(
      afterRuntimeUninstall.plugins?.entries?.["cognitive-runtime"],
      undefined,
      "the exact Host must not be treated as retaining uninstalled Plugin config",
    );
    await assert.rejects(
      initialFitness.fitness.publishFitnessContextProjection({
        openclawConfig: afterRuntimeUninstall,
        generatedAt: "2026-08-24T00:04:00.000Z",
      }),
      /Stella Fitness context contract rejected: LOCATOR_REQUIRED/,
    );
    gateway = spawnGateway(port, token, environment);
    await waitForGatewayProcessReady(gateway);
    await waitForDeepGatewayProbe(environment);
    const { stdout: standaloneFitnessOutput } = await run(
      "openclaw",
      ["plugins", "inspect", "stella-fitness", "--runtime", "--json"],
      { env: environment },
    );
    assert.equal(parseJsonOutput(standaloneFitnessOutput).plugin.status, "loaded");
    await stopGateway(gateway);
    gateway = undefined;
    await run("openclaw", ["plugins", "install", installSpec], {
      env: environment,
    });
    runtimeInstalled = true;
    const afterRuntimeReinstall = JSON.parse(await readFile(configPath, "utf8"));
    afterRuntimeReinstall.plugins.entries["cognitive-runtime"] =
      installedConfig.plugins.entries["cognitive-runtime"];
    await writeFile(configPath, `${JSON.stringify(afterRuntimeReinstall, null, 2)}\n`, {
      mode: 0o600,
    });
    await assertLocatorPreserved();

    await run(
      "openclaw",
      ["plugins", "uninstall", "stella-fitness", "--force"],
      { env: environment },
    );
    fitnessInstalled = false;
    const afterFitnessUninstall = await assertLocatorPreserved();
    assert.equal(
      afterFitnessUninstall.plugins?.entries?.["stella-fitness"],
      undefined,
      "the exact Host must not be treated as retaining uninstalled Plugin config",
    );
    await run("openclaw", ["plugins", "install", fitnessPackage.installSpec], {
      env: environment,
    });
    fitnessInstalled = true;
    const afterFitnessReinstall = JSON.parse(await readFile(configPath, "utf8"));
    afterFitnessReinstall.plugins.entries["stella-fitness"] =
      installedConfig.plugins.entries["stella-fitness"];
    await writeFile(configPath, `${JSON.stringify(afterFitnessReinstall, null, 2)}\n`, {
      mode: 0o600,
    });
    await assertLocatorPreserved();
    gateway = spawnGateway(port, token, environment);
    await waitForGatewayProcessReady(gateway);
    await waitForDeepGatewayProbe(environment);
    await waitForRuntimeHealth(runtimeConfig.runtime_storage);
    await verifyExactHostBeforeAgentRunGate(environment, modelServer.requests);
    await verifyPackedHostNegativeMatrices(
      environment,
      port,
      token,
      modelServer.requests,
    );
    await verifyPackedUnsmokedHostGates({
      runtime: installedRuntime,
      pluginRoot,
      runtimeConfig,
      authorityDirectory,
      environment,
      configPath,
      port,
      token,
      modelRequests: modelServer.requests,
      restartGateway,
      readGatewayDiagnostics: () => gateway?.diagnostics ?? "",
    });
    await verifyExactHostFailureRecovery({
      runtime: installedRuntime,
      runtimeConfig,
      authorityDirectory,
      environment,
      configPath,
      modelServer,
      restartGateway,
      interruptGateway,
    });
    await verifyExactHostDriftGates({
      runtimeConfig,
      environment,
      modelServer,
      port,
      token,
    });
    const successors = await runHostSuccessors(
      environment,
      evidencePath,
      port,
      token,
    );
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
    assert.equal(
      modelServer.requests.some((request) =>
        JSON.stringify(request).includes("PLAIN_RUN")
        && JSON.stringify(request).includes("[current_input]")),
      false,
      "the CLI operational probe must not receive a private cognitive packet",
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
      if (fitnessInstalled) {
        await run(
          "openclaw",
          ["plugins", "uninstall", "stella-fitness", "--force"],
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
