import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readRuntimeConfig,
  registerRuntimeHooks,
} from "../../dist/openclaw/runtime.js";
import plugin from "../../dist/openclaw/index.js";
import { calculateRegistryChecksum } from "../../dist/router/index.js";
import {
  calculateRuntimeConfigIdentityChecksum,
} from "../../dist/runtime/binding.js";
import { buildGeneration } from "../../dist/generation/index.js";
import { createStateManagementPort } from "../../dist/state/management.js";
import {
  provenanceDatabasePath,
  SqliteProvenanceStore,
} from "../../dist/provenance/index.js";
import {
  cognitiveMarkdown,
  commitSyntheticAuthority,
  writeSyntheticAuthority,
} from "../helpers/synthetic-authority.mjs";

const generation = `generation-${"a".repeat(64)}`;
const nextGeneration = `generation-${"b".repeat(64)}`;

const config = (mode = "enforce", paths = {}) => readRuntimeConfig({
  runtime: {
    schema_version: "cognitive-runtime.instance-runtime-config/v2",
    instance_id: "instance-synthetic",
    mode,
    runtime_storage: paths.runtimeStorage ?? "/synthetic/runtime",
    generation_storage: paths.generationStorage ?? "/synthetic/generations",
    host: {
      agent_id: "main",
      eligible_scope: ["private_main_session"],
    },
    authority_owner: { provider: "telegram", actor_id: "owner-synthetic" },
    limits: { max_active_runs: 4, drain_timeout_ms: 30_000 },
    adapters: {
      authority_checkout: "authority-local",
      host_retrieval: "openclaw-memory",
    },
  },
});

const routerResult = {
  memory_route: "none",
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
};

const binding = (suffix = "one", generationId = generation) => {
  const entries = [
    {
      id: "state-synthetic",
      role: "current_state",
      version: `view-${suffix}`,
      syncGeneration: generationId,
      checksum: `sha256:${"1".repeat(64)}`,
    },
    {
      id: "cog-governing",
      role: "governing_system",
      version: "1",
      syncGeneration: generationId,
      checksum: `sha256:${"2".repeat(64)}`,
    },
  ];
  return {
    syncGeneration: generationId,
    authorityRevision: "a".repeat(40),
    stateViewVersion: `view-${suffix}`,
    activeGoverningSystem: "cog-governing",
    registry: { checksum: calculateRegistryChecksum(entries), entries },
    context: {
      stateView: [{ id: "state-synthetic", content: `state-${suffix}` }],
      semanticClaims: [],
      evidenceRefs: [],
      governing: {
        system: { id: "cog-governing", version: "1", content: "kernel" },
        modules: [],
      },
      frameworks: [],
    },
    activationReceiptId: "activation-synthetic",
  };
};

const createRuntime = ({ mode = "enforce", compile } = {}) => {
  const hooks = new Map();
  const logs = [];
  const calls = [];
  const controller = registerRuntimeHooks({
    runtime: {
      version: "2026.6.34",
      llm: { complete: async (request) => {
        calls.push(request);
        return { text: JSON.stringify(routerResult) };
      } },
    },
    on(name, handler) { hooks.set(name, handler); },
    registerCli() {},
    logger: { info() {}, warn(message) { logs.push(JSON.parse(message)); } },
  }, config(mode), {
    bindingCompiler: { compile: compile ?? (async () => binding()) },
  });
  return { hooks, logs, calls, controller };
};

const eligible = (runId) => ({
  runId,
  sessionKey: "agent:main:telegram:direct:owner-synthetic",
  agentId: "main",
  trigger: "user",
  messageProvider: "telegram",
  senderId: "owner-synthetic",
  chatId: "owner-synthetic",
});

test("eligible Run compiles once and pins Generation and State View until cleanup", async () => {
  let next = binding("one");
  let compileCalls = 0;
  const compiledGenerations = [];
  const runtime = createRuntime({ compile: async () => {
    compileCalls += 1;
    compiledGenerations.push(next.syncGeneration);
    return next;
  } });

  const first = await runtime.hooks.get("before_prompt_build")(
    { prompt: "first", messages: [] }, eligible("run-one"),
  );
  next = binding("two", nextGeneration);
  const repeated = await runtime.hooks.get("before_prompt_build")(
    { prompt: "changed", messages: [] }, eligible("run-one"),
  );
  const secondRun = await runtime.hooks.get("before_prompt_build")(
    { prompt: "second", messages: [] }, {
      ...eligible("run-two"),
      sessionKey: "agent:main:main",
    },
  );

  assert.equal(compileCalls, 2);
  assert.deepEqual(compiledGenerations, [generation, nextGeneration]);
  assert.equal(runtime.calls.length, 2);
  assert.match(first.prependContext, /state-one/);
  assert.deepEqual(repeated, first);
  assert.match(secondRun.prependContext, /state-two/);
  assert.equal(runtime.controller.metrics().activeRuns, 2);

  await runtime.hooks.get("agent_end")({ success: true }, eligible("run-one"));
  assert.equal(runtime.controller.metrics().activeRuns, 1);
  assert.equal(runtime.controller.clearLifecycle("restart"), 1);
  assert.equal(runtime.controller.metrics().activeRuns, 0);
});

test("exact OpenClaw hook fields exclude callbacks, probes, shared chats, and other agents", async () => {
  let compileCalls = 0;
  const runtime = createRuntime({ compile: async () => {
    compileCalls += 1;
    return binding();
  } });
  const excluded = [
    { ...eligible("confirmation"), trigger: "confirmation_callback" },
    { ...eligible("probe"), trigger: "operational_probe" },
    { ...eligible("index"), trigger: "index_operation" },
    { ...eligible("shared"), sessionKey: "agent:main:telegram:group:owner-synthetic" },
    { ...eligible("group"), sessionKey: "agent:main:telegram:group:synthetic" },
    { ...eligible("other"), agentId: "public-agent" },
    { ...eligible("wrong-owner"), senderId: "someone-else" },
    { ...eligible("wrong-chat"), chatId: "shared-chat" },
    { ...eligible("missing-trigger"), trigger: undefined },
    { ...eligible("unclassified"), messageProvider: undefined, senderId: undefined, chatId: undefined },
  ];
  for (const context of excluded) {
    assert.equal(await runtime.hooks.get("before_prompt_build")(
      { prompt: "excluded", messages: [] }, context,
    ), undefined);
  }
  assert.equal(compileCalls, 0);
  assert.equal(runtime.calls.length, 0);
});

test("off bypasses binding, observe validates without injection, and enforce fails closed", async () => {
  let offCalls = 0;
  const off = createRuntime({ mode: "off", compile: async () => {
    offCalls += 1;
    throw new Error("MUST_NOT_COMPILE");
  } });
  assert.equal(await off.hooks.get("before_prompt_build")(
    { prompt: "off", messages: [] }, eligible("run-off"),
  ), undefined);
  assert.equal(offCalls, 0);

  const observe = createRuntime({ mode: "observe" });
  assert.equal(await observe.hooks.get("before_prompt_build")(
    { prompt: "observe", messages: [] }, eligible("run-observe"),
  ), undefined);
  assert.equal(observe.calls.length, 1);

  const missing = createRuntime({
    compile: async () => { throw new Error("ACTIVE_GENERATION_POINTER_MISSING"); },
  });
  await assert.rejects(
    missing.hooks.get("before_prompt_build")(
      { prompt: "enforce", messages: [] }, eligible("run-enforce"),
    ),
    /COGNITIVE_BINDING_REJECTED:ACTIVE_GENERATION_POINTER_MISSING/,
  );
  assert.equal(missing.calls.length, 0);
  assert.ok(missing.logs.some((entry) =>
    entry.reasonCode === "ACTIVE_GENERATION_POINTER_MISSING"));
});

test("filesystem compiler validates Pointer, Receipt, Manifest, Host identity, and State View", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-run-binding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorityDirectory = join(root, "authority");
  const generationState = join(root, "generation-state");
  const runtimeStorage = join(root, "runtime");
  await writeSyntheticAuthority(authorityDirectory, {
    activeGoverningSystem: "cog-synthetic-governing",
    cognitive: cognitiveMarkdown({
      id: "cog-synthetic-governing",
      entityType: "governing_system",
      extraSections: [["Persistent Kernel", "Pinned synthetic kernel."]],
    }),
  });
  const sourceRevision = await commitSyntheticAuthority(authorityDirectory);
  const built = await buildGeneration({
    authorityDirectory,
    stateDirectory: generationState,
    sourceRevision,
    packageVersion: "0.2.0-test",
  });
  const state = createStateManagementPort({
    stateRoot: runtimeStorage,
    instanceId: "instance-synthetic",
  });
  await state.initialize();
  state.close();

  const runtimeConfig = config("enforce", {
    runtimeStorage,
    generationStorage: join(generationState, "generations"),
  });
  const manifestBytes = await readFile(join(built.generationDirectory, "manifest.json"));
  const manifestChecksum = `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`;
  const projectionChecksum = built.manifest.files.find(
    (file) => file.path === "projection-entries.json",
  ).checksum;
  const receipt = {
    schema_version: "cognitive-runtime.activation-receipt/v2",
    receipt_id: "activation-synthetic",
    instance_id: "instance-synthetic",
    generation_id: built.syncGeneration,
    source_revision: sourceRevision,
    manifest_checksum: manifestChecksum,
    projection_checksum: projectionChecksum,
    host_config_checksum: calculateRuntimeConfigIdentityChecksum(runtimeConfig),
    index_evidence: {
      deep_status: "pass",
      search_sentinel_checksum: `sha256:${"3".repeat(64)}`,
      get_sentinel_checksum: `sha256:${"4".repeat(64)}`,
    },
    openclaw_version: "2026.6.34",
    node_version: process.versions.node,
    verified_at: "2026-08-17T00:00:00.000Z",
  };
  await mkdir(join(runtimeStorage, "activation-receipts"), { recursive: true });
  await writeFile(join(runtimeStorage, "activation-receipts", "activation-synthetic.json"), JSON.stringify(receipt));
  await writeFile(join(runtimeStorage, "active-generation.json"), JSON.stringify({
    schema_version: "cognitive-runtime.active-generation-pointer/v2",
    instance_id: "instance-synthetic",
    generation_id: built.syncGeneration,
    source_revision: sourceRevision,
    manifest_checksum: manifestChecksum,
    activation_receipt_id: "activation-synthetic",
    activated_at: "2026-08-17T00:00:00.000Z",
  }));

  const hooks = new Map();
  registerRuntimeHooks({
    runtime: {
      version: "2026.6.34",
      llm: { complete: async () => ({ text: JSON.stringify({
        ...routerResult,
        state_refs: [],
        governing: {
          system: "cog-synthetic-governing",
          kernel_version: "1",
          modules: [],
        },
      }) }) },
    },
    on(name, handler) { hooks.set(name, handler); },
    registerCli() {},
  }, runtimeConfig);

  const result = await hooks.get("before_prompt_build")(
    { prompt: "compile", messages: [] }, eligible("filesystem"),
  );
  assert.match(result.prependContext, /Pinned synthetic kernel/);

  const observeHooks = new Map();
  await plugin.register({
    pluginConfig: { runtime: { ...runtimeConfig, mode: "observe" } },
    runtime: {
      version: "2026.6.34",
      llm: { complete: async () => ({ text: JSON.stringify({
        ...routerResult,
        state_refs: [],
        governing: {
          system: "cog-synthetic-governing",
          kernel_version: "1",
          modules: [],
        },
      }) }) },
    },
    on(name, handler) { observeHooks.set(name, handler); },
    registerCli() {},
  });
  assert.equal(await observeHooks.get("before_prompt_build")(
    { prompt: "observe", messages: [] }, eligible("filesystem-observe"),
  ), undefined);
  await observeHooks.get("agent_end")(
    { success: true, messages: [] }, eligible("filesystem-observe"),
  );
  const traces = new SqliteProvenanceStore({
    databasePath: provenanceDatabasePath(runtimeStorage, "instance-synthetic"),
  });
  assert.equal((await traces.query({ runId: "filesystem-observe" })).length, 1);
  traces.close();

  receipt.host_config_checksum = `sha256:${"f".repeat(64)}`;
  await writeFile(join(runtimeStorage, "activation-receipts", "activation-synthetic.json"), JSON.stringify(receipt));
  await assert.rejects(
    hooks.get("before_prompt_build")(
      { prompt: "stale", messages: [] }, eligible("filesystem-stale"),
    ),
    /COGNITIVE_BINDING_REJECTED:ACTIVATION_CONFIG_IDENTITY_STALE/,
  );
});
