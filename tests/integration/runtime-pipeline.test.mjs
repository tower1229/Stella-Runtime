import assert from "node:assert/strict";
import test from "node:test";

import plugin from "../../dist/openclaw/index.js";
import { calculateRegistryChecksum } from "../../dist/router/index.js";

const routerResult = (memoryRoute = "none") => ({
  memory_route: memoryRoute,
  state_refs: ["state-synthetic"],
  governing: {
    system: "cog-governing",
    kernel_version: "1",
    modules: [],
  },
  frameworks: { primary: null, secondary: null },
  retrieval_plan: [],
  confidence: 1,
  reason_codes: ["SYNTHETIC_ROUTE"],
});

const requiredRouterResult = () => ({
  ...routerResult("required"),
  retrieval_plan: [{
    layer: "semantic",
    method: "direct_get",
    target: "sem-synthetic",
    query: null,
    purpose: "Recall the selected semantic claim",
  }],
});

const entries = [
  {
    id: "state-synthetic",
    role: "current_state",
    version: "1",
    syncGeneration: "generation-synthetic",
    checksum: `sha256:${"1".repeat(64)}`,
  },
  {
    id: "cog-governing",
    role: "governing_system",
    version: "1",
    syncGeneration: "generation-synthetic",
    checksum: `sha256:${"2".repeat(64)}`,
  },
  {
    id: "sem-synthetic",
    role: "semantic",
    version: "1",
    syncGeneration: "generation-synthetic",
    checksum: `sha256:${"3".repeat(64)}`,
  },
];
const registryChecksum = calculateRegistryChecksum(entries);

const runtimeConfig = (mode = "enforce") => ({
  mode,
  limits: {
    routerTimeoutMs: 1_000,
    routerMaxTokens: 256,
    routerMaxInputCharacters: 4_000,
    routerMaxOutputCharacters: 4_000,
    packetMaxCharacters: 4_000,
    scratchCapacity: 2,
    scratchTtlMs: 10_000,
  },
  binding: {
    syncGeneration: "generation-synthetic",
    authorityRevision: "revision-synthetic",
    stateViewVersion: "view-synthetic",
    activeGoverningSystem: "cog-governing",
    registry: { checksum: registryChecksum, entries },
    context: {
      stateView: [{ id: "state-synthetic", content: "Synthetic state" }],
      semanticClaims: [{ id: "sem-synthetic", content: "Synthetic claim" }],
      evidenceRefs: [],
      governing: {
        system: { id: "cog-governing", version: "1", content: "Synthetic kernel" },
        modules: [],
      },
      frameworks: [],
    },
  },
});

const register = async ({ mode = "enforce", result = routerResult(), complete, recordProvenance } = {}) => {
  const hooks = new Map();
  const logs = [];
  const calls = [];
  await plugin.register({
    pluginConfig: { runtime: runtimeConfig(mode) },
    runtime: {
      llm: {
        complete: complete ?? (async (request) => {
          calls.push(request);
          return { text: JSON.stringify(result) };
        }),
      },
    },
    on(name, handler) { hooks.set(name, handler); },
    registerCli() {},
    logger: {
      info(message) { logs.push(JSON.parse(message)); },
      warn(message) { logs.push(JSON.parse(message)); },
    },
  });
  return { hooks, logs, calls };
};

test("enforce pipeline routes once, reuses binding, and injects an explicit packet", async () => {
  const { hooks, calls } = await register();
  const context = { runId: "run-synthetic-1", sessionKey: "session-synthetic" };
  const first = await hooks.get("before_prompt_build")(
    { prompt: "Choose", messages: [{ role: "user", content: "Earlier" }] },
    context,
  );
  const repeated = await hooks.get("before_prompt_build")(
    { prompt: "Choose", messages: [] },
    context,
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].maxTokens, 256);
  assert.equal(calls[0].temperature, 0);
  assert.match(first.prependContext, /\[governing_kernel:cog-governing@1\]/);
  assert.match(first.prependContext, /\[current_state:state-synthetic\]/);
  assert.deepEqual(repeated, first);
});

test("required retrieval accepts only declared memory refs and revises at most once", async () => {
  const { hooks } = await register({ result: requiredRouterResult() });
  const context = { runId: "run-synthetic-2", sessionKey: "session-synthetic" };
  await hooks.get("before_prompt_build")({ prompt: "Choose", messages: [] }, context);

  assert.deepEqual(await hooks.get("before_agent_finalize")(
    { runId: context.runId, sessionId: "session-id", stopHookActive: false },
    context,
  ), {
    action: "revise",
    reason: "COGNITIVE_RETRIEVAL_REQUIRED",
    retry: {
      instruction: "Complete the required cognitive retrieval plan, then answer.",
      idempotencyKey: "cognitive-runtime:run-synthetic-2:remediation",
      maxAttempts: 1,
    },
  });
  assert.equal(await hooks.get("before_agent_finalize")(
    { runId: context.runId, sessionId: "session-id", stopHookActive: false },
    context,
  ), undefined);

  await hooks.get("after_tool_call")({
    toolName: "ordinary_tool",
    toolCallId: "tool-ordinary",
    result: { details: { source_id: "sem-synthetic" } },
  }, context);
  await hooks.get("after_tool_call")({
    toolName: "memory_get",
    toolCallId: "tool-synthetic",
    result: { details: { source_id: "unknown-synthetic" } },
  }, context);
  await Promise.all([
    hooks.get("after_tool_call")({
      toolName: "memory_search",
      toolCallId: "tool-search",
      result: { details: { source_id: "sem-synthetic" } },
    }, context),
    hooks.get("after_tool_call")({
      toolName: "memory_get",
      toolCallId: "tool-search",
      result: { details: { source_id: "sem-synthetic" } },
    }, context),
  ]);
  await hooks.get("after_tool_call")({
    toolName: "memory_get",
    toolCallId: "tool-search",
    result: { details: { source_id: "state-synthetic" } },
  }, context);
  assert.equal(await hooks.get("before_agent_finalize")(
    { runId: context.runId, sessionId: "session-id", stopHookActive: false },
    context,
  ), undefined);
  await hooks.get("agent_end")({ runId: context.runId, messages: [], success: true }, context);
});

test("none route injects state and governing kernel but no extra retrieval content", async () => {
  const adversarial = {
    ...routerResult("none"),
    retrieval_plan: [{
      layer: "semantic",
      method: "direct_get",
      target: "sem-synthetic",
      query: null,
      purpose: "MUST_NOT_BE_INJECTED",
    }],
  };
  const { hooks } = await register({ result: adversarial });
  const result = await hooks.get("before_prompt_build")(
    { prompt: "Choose", messages: [] },
    { runId: "run-none" },
  );

  assert.match(result.prependContext, /Synthetic state/);
  assert.match(result.prependContext, /Synthetic kernel/);
  assert.doesNotMatch(result.prependContext, /Synthetic claim|MUST_NOT_BE_INJECTED/);
});

test("expired Run state fails open and does not reuse a private packet", async () => {
  const config = runtimeConfig();
  config.limits.scratchTtlMs = 1;
  const hooks = new Map();
  let calls = 0;
  const runtime = await import("../../dist/openclaw/runtime.js");
  runtime.registerRuntimeHooks({
    runtime: { llm: { complete: async () => {
      calls += 1;
      return { text: JSON.stringify(routerResult()) };
    } } },
    on(name, handler) { hooks.set(name, handler); },
    registerCli() {},
  }, runtime.readRuntimeConfig({ runtime: config }));
  const context = { runId: "run-expiring" };
  const first = await hooks.get("before_prompt_build")(
    { prompt: "PRIVATE_FIRST", messages: [] }, context,
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await hooks.get("after_tool_call")({
    toolName: "memory_get", toolCallId: "late", result: {},
  }, context), undefined);
  assert.equal(await hooks.get("before_agent_finalize")({}, context), undefined);
  const second = await hooks.get("before_prompt_build")(
    { prompt: "PUBLIC_SECOND", messages: [] }, context,
  );

  assert.equal(calls, 2);
  assert.match(first.prependContext, /PRIVATE_FIRST/);
  assert.doesNotMatch(second.prependContext, /PRIVATE_FIRST/);
  assert.match(second.prependContext, /PUBLIC_SECOND/);
});

test("observe, off, rejection, missing run id, and capacity fail without interrupting host", async () => {
  const observed = await register({ mode: "observe" });
  assert.equal(await observed.hooks.get("before_prompt_build")(
    { prompt: "Private synthetic prompt", messages: [] },
    { runId: "run-observe" },
  ), undefined);
  assert.equal(observed.calls.length, 1);

  const off = await register({ mode: "off" });
  assert.equal(await off.hooks.get("before_prompt_build")(
    { prompt: "Prompt", messages: [] }, { runId: "run-off" },
  ), undefined);
  assert.equal(off.calls.length, 0);

  const rejected = await register({ complete: async () => ({ text: "not-json" }) });
  assert.equal(await rejected.hooks.get("before_prompt_build")(
    { prompt: "Prompt", messages: [] }, { runId: "run-rejected" },
  ), undefined);
  assert.ok(rejected.logs.some((entry) => entry.reasonCode === "ROUTER_NON_JSON_OUTPUT"));
  assert.equal(await rejected.hooks.get("before_prompt_build")(
    { prompt: "Prompt", messages: [] }, {},
  ), undefined);
  assert.ok(rejected.logs.some((entry) => entry.reasonCode === "RUN_ID_REQUIRED"));

  await rejected.hooks.get("before_prompt_build")(
    { prompt: "Prompt", messages: [] }, { runId: "run-capacity-a" },
  );
  const callsBeforeCapacity = rejected.calls.length;
  assert.equal(await rejected.hooks.get("before_prompt_build")(
    { prompt: "Prompt", messages: [] }, { runId: "run-capacity-b" },
  ), undefined);
  assert.ok(rejected.logs.some((entry) => entry.reasonCode === "RUN_SCRATCH_CAPACITY"));
  assert.equal(rejected.calls.length, callsBeforeCapacity);
});

test("unserializable recent context degrades safely without interrupting the host", async () => {
  const circular = {};
  circular.self = circular;
  const { hooks, calls } = await register();

  const result = await hooks.get("before_prompt_build")(
    { prompt: "Prompt", messages: [circular] },
    { runId: "run-circular-context" },
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0].messages[0].content, /\[unserializable-message\]/);
  assert.match(result.prependContext, /\[current_input\]/);
});

test("runtime config rejects malformed registry and context before hook registration", async () => {
  const runtime = await import("../../dist/openclaw/runtime.js");
  const malformedRegistry = runtimeConfig();
  malformedRegistry.binding.registry.entries = [{ id: "missing-fields" }];
  assert.throws(
    () => runtime.readRuntimeConfig({ runtime: malformedRegistry }),
    /RUNTIME_REGISTRY_INVALID/,
  );

  const malformedContext = runtimeConfig();
  malformedContext.binding.context.stateView = [{ id: "state-synthetic" }];
  assert.throws(
    () => runtime.readRuntimeConfig({ runtime: malformedContext }),
    /RUNTIME_CONTEXT_INVALID/,
  );

  const mismatchedKernel = runtimeConfig();
  mismatchedKernel.binding.context.governing.system = {
    id: "governing-unvalidated",
    version: "999",
    content: "Unvalidated kernel",
  };
  assert.throws(
    () => runtime.readRuntimeConfig({ runtime: mismatchedKernel }),
    /GOVERNING_BINDING_INVALID/,
  );

  const unexpectedKernel = runtimeConfig();
  unexpectedKernel.binding.activeGoverningSystem = null;
  assert.throws(
    () => runtime.readRuntimeConfig({ runtime: unexpectedKernel }),
    /GOVERNING_BINDING_INVALID/,
  );
});

test("agent end records a minimal privacy-safe overlay and always clears the Run", async () => {
  const overlays = [];
  const hooks = new Map();
  const runtime = await import("../../dist/openclaw/runtime.js");
  const api = {
    runtime: { llm: { complete: async () => ({ text: JSON.stringify(requiredRouterResult()) }) } },
    on(name, handler) { hooks.set(name, handler); },
    registerCli() {},
    logger: { info() {}, warn() {} },
  };
  const controller = runtime.registerRuntimeHooks(
    api,
    runtime.readRuntimeConfig({ runtime: runtimeConfig() }),
    { recordProvenance: async (overlay) => { overlays.push(overlay); } },
  );
  const context = { runId: "run-private-safe", sessionKey: "session-private-safe" };
  await hooks.get("before_prompt_build")({
    prompt: "PRIVATE_PROMPT_SENTINEL",
    messages: [{ role: "assistant", content: "PRIVATE_ANSWER_SENTINEL" }],
  }, context);
  await hooks.get("after_tool_call")({
    toolName: "memory_get",
    toolCallId: "tool-private-safe",
    result: {
      content: "PRIVATE_TOOL_PAYLOAD_SENTINEL",
      details: { source_id: "sem-synthetic" },
    },
  }, context);
  await hooks.get("agent_end")({
    runId: context.runId,
    success: true,
    messages: [{ role: "assistant", content: "PRIVATE_ANSWER_SENTINEL" }],
  }, context);

  assert.equal(overlays.length, 1);
  assert.deepEqual(overlays[0].stable_refs, [
    { id: "sem-synthetic", status: "retrieved" },
  ]);
  assert.equal(overlays[0].validated_router_result, null);
  assert.deepEqual(overlays[0].cognitive_bindings, [
    { id: "state-synthetic", role: "current_state", version: "1", status: "injected" },
    { id: "cog-governing", role: "governing_system", version: "1", status: "injected" },
    { id: "sem-synthetic", role: "semantic", version: "1", status: "injected" },
  ]);
  assert.doesNotMatch(JSON.stringify(overlays[0]), /PRIVATE_/);
  assert.equal(controller.metrics().activeRuns, 0);
  assert.ok(controller.metrics().nonLlmDurationSamplesMs.length <= 100);
  const sortedDurations = [...controller.metrics().nonLlmDurationSamplesMs]
    .sort((left, right) => left - right);
  const p95 = sortedDurations[Math.ceil(sortedDurations.length * 0.95) - 1];
  assert.ok(p95 < 100, `expected non-LLM p95 < 100ms, received ${p95}ms`);
});

test("provenance failures log only a fixed bounded reason", async () => {
  const hooks = new Map();
  const logs = [];
  const runtime = await import("../../dist/openclaw/runtime.js");
  runtime.registerRuntimeHooks({
    runtime: { llm: { complete: async () => ({ text: JSON.stringify(routerResult()) }) } },
    on(name, handler) { hooks.set(name, handler); },
    registerCli() {},
    logger: { info() {}, warn(message) { logs.push(message); } },
  }, runtime.readRuntimeConfig({ runtime: runtimeConfig() }), {
    recordProvenance: async () => { throw new Error("PRIVATE_DATABASE_PATH_SENTINEL"); },
  });
  const context = { runId: "run-provenance-failure" };
  await hooks.get("before_prompt_build")({ prompt: "Prompt", messages: [] }, context);
  await hooks.get("agent_end")({ success: true }, context);

  assert.ok(logs.some((message) => message.includes("PROVENANCE_RECORD_FAILED")));
  assert.doesNotMatch(logs.join("\n"), /PRIVATE_DATABASE_PATH_SENTINEL/);
});

test("successful Runtime provenance persists through the real SQLite store", async (t) => {
  const runtime = await import("../../dist/openclaw/runtime.js");
  const { SqliteProvenanceStore } = await import("../../dist/provenance/index.js");
  const store = new SqliteProvenanceStore({ databasePath: ":memory:" });
  t.after(() => store.close());
  const hooks = new Map();
  runtime.registerRuntimeHooks({
    runtime: { llm: { complete: async () => ({ text: JSON.stringify(routerResult()) }) } },
    on(name, handler) { hooks.set(name, handler); },
    registerCli() {},
  }, runtime.readRuntimeConfig({ runtime: runtimeConfig() }), {
    recordProvenance: (overlay) => store.record(overlay),
  });
  const context = { runId: "run-real-provenance", sessionKey: "session-real" };
  await hooks.get("before_prompt_build")({ prompt: "Prompt", messages: [] }, context);
  await hooks.get("agent_end")({ success: true }, context);

  const persisted = await store.query({ runId: context.runId });
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].validated_router_result, null);
  assert.deepEqual(persisted[0].cognitive_bindings, [
    { id: "state-synthetic", role: "current_state", version: "1", status: "injected" },
    { id: "cog-governing", role: "governing_system", version: "1", status: "injected" },
  ]);
});

test("packet includes only Router-selected optional context and lifecycle cleanup is explicit", async () => {
  const hooks = new Map();
  const runtime = await import("../../dist/openclaw/runtime.js");
  const configured = runtimeConfig();
  configured.binding.context.semanticClaims = [
    { id: "sem-synthetic", content: "MUST_NOT_BE_INJECTED" },
  ];
  const api = {
    runtime: { llm: { complete: async () => ({ text: JSON.stringify(routerResult()) }) } },
    on(name, handler) { hooks.set(name, handler); },
    registerCli() {},
  };
  const controller = runtime.registerRuntimeHooks(
    api,
    runtime.readRuntimeConfig({ runtime: configured }),
  );
  const result = await hooks.get("before_prompt_build")(
    { prompt: "Choose", messages: [] },
    { runId: "run-lifecycle" },
  );

  assert.doesNotMatch(result.prependContext, /MUST_NOT_BE_INJECTED/);
  assert.equal(controller.metrics().activeRuns, 1);
  assert.equal(controller.clearLifecycle("disable"), 1);
  assert.equal(controller.metrics().activeRuns, 0);
});

test("concurrent prompt hooks for one Run share one Router completion", async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const { hooks } = await register({
    complete: async () => {
      calls += 1;
      await barrier;
      return { text: JSON.stringify(routerResult()) };
    },
  });
  const event = { prompt: "Choose", messages: [] };
  const context = { runId: "run-concurrent" };
  const first = hooks.get("before_prompt_build")(event, context);
  const second = hooks.get("before_prompt_build")(event, context);
  release();
  const [left, right] = await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.deepEqual(left, right);
});

test("host completion nested prompt hook is excluded from Runtime routing", async () => {
  const hooks = new Map();
  let completionCalls = 0;
  const api = {
    pluginConfig: { runtime: runtimeConfig() },
    runtime: {
      llm: {
        complete: async () => {
          completionCalls += 1;
          assert.equal(await hooks.get("before_prompt_build")(
            { prompt: "Nested host completion", messages: [] },
            { runId: "run-host-completion" },
          ), undefined);
          return { text: JSON.stringify(routerResult()) };
        },
      },
    },
    on(name, handler) { hooks.set(name, handler); },
    registerCli() {},
  };
  await plugin.register(api);

  const result = await hooks.get("before_prompt_build")(
    { prompt: "User run", messages: [] },
    { runId: "run-user" },
  );
  assert.equal(completionCalls, 1);
  assert.match(result.prependContext, /\[current_input\]\nUser run/);
});

test("plugin lifecycle cleanup clears active Run scratch", async () => {
  const hooks = new Map();
  let lifecycle;
  const api = {
    pluginConfig: { runtime: runtimeConfig() },
    runtime: { llm: { complete: async () => ({ text: JSON.stringify(routerResult()) }) } },
    on(name, handler) { hooks.set(name, handler); },
    lifecycle: { registerRuntimeLifecycle(value) { lifecycle = value; } },
    registerCli() {},
  };
  await plugin.register(api);
  await hooks.get("before_prompt_build")(
    { prompt: "User run", messages: [] },
    { runId: "run-lifecycle-host" },
  );

  assert.equal(lifecycle.id, "cognitive-runtime-run-scratch");
  await lifecycle.cleanup({ reason: "restart" });
  assert.equal(await hooks.get("before_agent_finalize")(
    { runId: "run-lifecycle-host", sessionId: "session-id", stopHookActive: false },
    { runId: "run-lifecycle-host" },
  ), undefined);
});

test("lifecycle cleanup invalidates an in-flight Router completion", async () => {
  const hooks = new Map();
  let lifecycle;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const api = {
    pluginConfig: { runtime: runtimeConfig() },
    runtime: { llm: { complete: async () => {
      await barrier;
      return { text: JSON.stringify(routerResult()) };
    } } },
    on(name, handler) { hooks.set(name, handler); },
    lifecycle: { registerRuntimeLifecycle(value) { lifecycle = value; } },
    registerCli() {},
  };
  await plugin.register(api);
  const pending = hooks.get("before_prompt_build")(
    { prompt: "Must be invalidated", messages: [] },
    { runId: "run-in-flight-cleanup" },
  );
  await lifecycle.cleanup({ reason: "disable" });
  release();

  assert.equal(await pending, undefined);
  assert.equal(await hooks.get("before_agent_finalize")(
    {}, { runId: "run-in-flight-cleanup" },
  ), undefined);
});
