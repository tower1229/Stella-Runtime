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
  FileBindingCompiler,
} from "../../dist/runtime/binding.js";
import { buildGeneration } from "../../dist/generation/index.js";
import { loadMaintenanceGate, syncGeneration } from "../../dist/sync/index.js";
import {
  ProjectionDeterminismLedger,
  runProjectionProducerConformance,
} from "../../dist/personal-data/projection.js";
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

const fitnessDomain = () => {
  const publication = runProjectionProducerConformance({
    instanceId: "instance-synthetic",
    producerId: "stella-fitness",
    consumerId: "stella-runtime",
    canonicalSourceSnapshot: {
      revision: "fitness-f1",
      sourceAsOf: "2026-08-24T00:00:00Z",
    },
    determinismLedger: new ProjectionDeterminismLedger(),
    categories: ["fitness_history"],
    sourceReferences: [],
    conflicts: [],
    retractions: [],
    capabilities: [{ id: "fitness_history_context", state: "available" }],
    payloads: [{
      stableId: "fitness-history",
      path: "payloads/history.md",
      mediaType: "text/markdown",
      value: "# Fitness history\n\nSynthetic session.\n",
    }],
    generatedAt: "2026-08-24T00:01:00Z",
  });
  return {
    domainId: "fitness",
    projection: {
      status: "active",
      projectionRevision: publication.projectionRevision,
      pointerRevision: `pointer-${"2".repeat(64)}`,
      manifestChecksum: publication.manifestChecksum,
      sourceRevision: publication.manifest.source.revision,
      asOf: publication.manifest.source.as_of,
      manifest: publication.manifest,
      payloads: publication.payloads,
    },
  };
};

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

const createRuntime = ({ mode = "enforce", compile, revalidate, complete, paths = {}, healthGate } = {}) => {
  const hooks = new Map();
  const logs = [];
  const calls = [];
  const controller = registerRuntimeHooks({
    runtime: {
      version: "2026.6.34",
      llm: { complete: async (request) => {
        calls.push(request);
        return complete === undefined
          ? { text: JSON.stringify(routerResult) }
          : complete(request);
      } },
    },
    on(name, handler) { hooks.set(name, handler); },
    registerCli() {},
    logger: { info() {}, warn(message) { logs.push(JSON.parse(message)); } },
  }, config(mode, paths), {
    bindingCompiler: {
      compile: compile ?? (async () => binding()),
      ...(revalidate === undefined ? {} : { revalidate }),
    },
    ...(healthGate === undefined ? {} : { healthGate }),
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

test("Eligible Run binding rejects an engine-compatible Host absent from the matrix", async () => {
  await assert.rejects(new FileBindingCompiler().compile({
    config: config("enforce"),
    hostVersion: "2026.6.34",
    nodeVersion: "24.17.0",
  }), { message: "INCOMPATIBLE_HOST" });
});

test("Eligible Run hook preserves the stable incompatible Host reason", async () => {
  const runtime = createRuntime({
    compile: async () => { throw new Error("INCOMPATIBLE_HOST"); },
  });

  await assert.rejects(
    runtime.hooks.get("before_prompt_build")(
      { prompt: "incompatible", messages: [] },
      eligible("run-incompatible-host"),
    ),
    /COGNITIVE_BINDING_REJECTED:INCOMPATIBLE_HOST/,
  );
  assert.ok(runtime.logs.some((entry) => entry.reasonCode === "INCOMPATIBLE_HOST"));
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

test("both Eligible Run hooks re-read domain pointers without replacing the pinned binding", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-domain-drift-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeStorage = join(root, "runtime");
  let compileCalls = 0;
  let revalidateCalls = 0;
  const pinned = {
    ...binding("one"),
    domainInputs: [{
      domain_id: "fitness",
      status: "active",
      projection_revision: `projection-${"1".repeat(64)}`,
      pointer_revision: `pointer-${"2".repeat(64)}`,
      manifest_checksum: `sha256:${"3".repeat(64)}`,
      source_revision: "fitness-f1",
      as_of: "2026-08-24T00:00:00Z",
    }],
  };
  let currentPointerRevision = pinned.domainInputs[0].pointer_revision;
  const runtime = createRuntime({
    paths: { runtimeStorage },
    compile: async () => { compileCalls += 1; return pinned; },
    revalidate: async (active) => {
      revalidateCalls += 1;
      if (active.domainInputs[0].pointer_revision !== currentPointerRevision) {
        throw new Error("ACTIVE_DOMAIN_POINTER_DRIFT");
      }
    },
  });

  await runtime.hooks.get("before_prompt_build")(
    { prompt: "first", messages: [] },
    eligible("domain-pinned"),
  );
  currentPointerRevision = `pointer-${"4".repeat(64)}`;
  const decision = await runtime.hooks.get("before_agent_run")(
    { prompt: "first", messages: [] },
    eligible("domain-pinned"),
  );

  assert.equal(compileCalls, 1);
  assert.equal(revalidateCalls, 1);
  assert.equal(decision.outcome, "block");
  assert.equal(decision.metadata.reasonCode, "ACTIVE_DOMAIN_POINTER_DRIFT");
  assert.equal(
    (await loadMaintenanceGate(runtimeStorage))?.targetSourceRevision,
    pinned.authorityRevision,
  );
  const nextDecision = await runtime.hooks.get("before_agent_run")(
    { prompt: "next", messages: [] },
    eligible("domain-next"),
  );
  assert.equal(nextDecision.outcome, "block");
  assert.equal(nextDecision.metadata.reasonCode, "MAINTENANCE_GATE_CLOSED");
});

test("overlapping Eligible Run hooks independently revalidate before the final model request", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-domain-overlap-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let releaseCompile;
  const compileReleased = new Promise((resolve) => { releaseCompile = resolve; });
  let compileStarted;
  const started = new Promise((resolve) => { compileStarted = resolve; });
  const pinned = {
    ...binding("overlap"),
    domainInputs: [{
      domain_id: "fitness",
      status: "active",
      projection_revision: `projection-${"1".repeat(64)}`,
      pointer_revision: `pointer-${"2".repeat(64)}`,
      manifest_checksum: `sha256:${"3".repeat(64)}`,
      source_revision: "fitness-overlap",
      as_of: "2026-08-24T00:00:00Z",
    }],
  };
  let currentPointerRevision = pinned.domainInputs[0].pointer_revision;
  const runtime = createRuntime({
    paths: { runtimeStorage: join(root, "runtime") },
    compile: async () => {
      compileStarted();
      await compileReleased;
      return pinned;
    },
    revalidate: async (active) => {
      if (active.domainInputs[0].pointer_revision !== currentPointerRevision) {
        throw new Error("ACTIVE_DOMAIN_POINTER_DRIFT");
      }
    },
  });
  const event = { prompt: "overlap", messages: [] };
  const context = eligible("domain-overlap");
  const promptHook = runtime.hooks.get("before_prompt_build")(event, context);
  await started;
  const finalHook = runtime.hooks.get("before_agent_run")(event, context);
  currentPointerRevision = `pointer-${"4".repeat(64)}`;
  releaseCompile();

  await promptHook;
  const decision = await finalHook;
  assert.equal(decision.outcome, "block");
  assert.equal(decision.metadata.reasonCode, "ACTIVE_DOMAIN_POINTER_DRIFT");
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

test("Gateway CLI private-session runs fail closed before the Agent model request", async () => {
  const runtime = createRuntime({ complete: async () => ({ text: "not-json" }) });
  const decision = await runtime.hooks.get("before_agent_run")(
    { prompt: "invalid route", messages: [] },
    { ...eligible("gateway-cli"), senderId: undefined },
  );

  assert.equal(decision.outcome, "block");
  assert.equal(decision.metadata.reasonCode, "ROUTER_NON_JSON_OUTPUT");
  assert.equal(runtime.calls.length, 1);
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

test("persisted drift gates enforce Runs while observe records without injection", async () => {
  const lifecycle = [];
  const gate = {
    checkRunGate: async () => ({ allowed: false, reasonCodes: ["INDEX_DRIFT"] }),
    recordLifecycle: (outcome) => lifecycle.push(outcome),
  };
  let enforceCompiles = 0;
  const enforce = createRuntime({
    healthGate: gate,
    compile: async () => {
      enforceCompiles += 1;
      return binding();
    },
  });
  await assert.rejects(
    enforce.hooks.get("before_prompt_build")(
      { prompt: "enforce", messages: [] }, eligible("run-drift-enforce"),
    ),
    /COGNITIVE_BINDING_REJECTED:INDEX_DRIFT/,
  );
  assert.equal(enforceCompiles, 0);
  assert.deepEqual(lifecycle, ["gated"]);

  let observeCompiles = 0;
  const observe = createRuntime({
    mode: "observe",
    healthGate: gate,
    compile: async () => {
      observeCompiles += 1;
      return binding();
    },
  });
  assert.equal(await observe.hooks.get("before_prompt_build")(
    { prompt: "observe", messages: [] }, eligible("run-drift-observe"),
  ), undefined);
  assert.equal(observeCompiles, 1);
  assert.ok(observe.logs.some((entry) => entry.reasonCode === "INDEX_DRIFT"));
});

test("a durable Maintenance Gate rejects new eligible Runs before binding compilation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-maintenance-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeStorage = join(root, "runtime");
  await mkdir(runtimeStorage, { recursive: true });
  await writeFile(join(runtimeStorage, "maintenance-gate.json"), JSON.stringify({
    target_source_revision: "a".repeat(40),
    closed_at: "2026-08-17T00:00:00.000Z",
  }));
  let compileCalls = 0;
  const runtime = createRuntime({
    paths: { runtimeStorage },
    compile: async () => {
      compileCalls += 1;
      return binding();
    },
  });

  await assert.rejects(
    runtime.hooks.get("before_prompt_build")(
      { prompt: "blocked", messages: [] },
      eligible("run-maintenance"),
    ),
    /COGNITIVE_BINDING_REJECTED:MAINTENANCE_GATE_CLOSED/,
  );
  assert.equal(compileCalls, 0);
  assert.equal(runtime.controller.metrics().activeRuns, 0);
});

test("Maintenance Gate lets an existing pinned Run drain while rejecting a new Run", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-maintenance-drain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeStorage = join(root, "runtime");
  const runtime = createRuntime({
    paths: { runtimeStorage },
    compile: async () => binding(),
  });
  const first = await runtime.hooks.get("before_prompt_build")(
    { prompt: "first", messages: [] },
    eligible("run-existing"),
  );
  await mkdir(runtimeStorage, { recursive: true });
  await writeFile(join(runtimeStorage, "maintenance-gate.json"), JSON.stringify({
    target_source_revision: "a".repeat(40),
    closed_at: "2026-08-17T00:00:00.000Z",
  }));

  assert.deepEqual(await runtime.hooks.get("before_prompt_build")(
    { prompt: "repeat", messages: [] },
    eligible("run-existing"),
  ), first);
  await assert.rejects(
    runtime.hooks.get("before_prompt_build")(
      { prompt: "new", messages: [] },
      eligible("run-new"),
    ),
    /COGNITIVE_BINDING_REJECTED:MAINTENANCE_GATE_CLOSED/,
  );
  assert.equal(runtime.controller.metrics().activeRuns, 1);
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
    release_channel: "extended-stable",
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

test("filesystem compiler negotiates v3 and fail-closes domain tuple drift", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-run-binding-v3-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorityDirectory = join(root, "authority");
  const generationState = join(root, "generation-state");
  const runtimeStorage = join(root, "runtime");
  await writeSyntheticAuthority(authorityDirectory);
  const sourceRevision = await commitSyntheticAuthority(authorityDirectory);
  const runtimeConfig = config("enforce", {
    runtimeStorage,
    generationStorage: join(generationState, "generations"),
  });
  runtimeConfig.adapters.authority_checkout = authorityDirectory;
  const state = createStateManagementPort({
    stateRoot: runtimeStorage,
    instanceId: "instance-synthetic",
  });
  await state.initialize();
  state.close();
  const domain = fitnessDomain();
  const expected = {
    domain_id: domain.domainId,
    status: domain.projection.status,
    projection_revision: domain.projection.projectionRevision,
    pointer_revision: domain.projection.pointerRevision,
    manifest_checksum: domain.projection.manifestChecksum,
    source_revision: domain.projection.sourceRevision,
    as_of: domain.projection.asOf,
  };
  const synced = await syncGeneration({
    config: runtimeConfig,
    sourceRevision,
    packageVersion: "0.2.1-test",
    hostVersion: "2026.6.34",
    nodeVersion: process.versions.node,
    domainProjections: [domain],
    domainProjectionReader: { async read() { return expected; } },
    host: {
      async capture() { return {}; },
      async applyTarget() {},
      async verifyTarget(target) {
        return {
          deepStatus: "pass",
          generationId: target.syncGeneration,
          sourceRevision: target.sourceRevision,
          projectionChecksum: target.projectionChecksum,
          hostConfigChecksum: target.hostConfigChecksum,
          searchSentinelChecksum: `sha256:${"3".repeat(64)}`,
          getSentinelChecksum: `sha256:${"4".repeat(64)}`,
          domains: target.domainIndexes.map((indexed) => ({
            domainId: indexed.domain_id,
            projectionRevision: indexed.projection_revision,
            manifestChecksum: indexed.manifest_checksum,
            desiredCount: indexed.desired_count,
            indexedCount: indexed.desired_count,
            previousRevision: null,
            previousStableIdHits: 0,
            previousTextSentinelHits: 0,
            previousSourceReferenceHits: 0,
          })),
        };
      },
      async restore() {},
      async verifyPrior() { throw new Error("UNEXPECTED_PRIOR_VERIFY"); },
    },
    runs: {
      closeAdmission() {},
      openAdmission() {},
      async drain() {},
    },
  });
  let current = expected;
  const compiler = new FileBindingCompiler({
    domainProjectionReader: { async read() { return current; } },
  });
  const compiled = await compiler.compile({
    config: runtimeConfig,
    hostVersion: "2026.6.34",
    nodeVersion: process.versions.node,
  });
  assert.deepEqual(compiled.domainInputs, [expected]);

  current = { ...expected, pointer_revision: `pointer-${"5".repeat(64)}` };
  await assert.rejects(
    compiler.revalidate(compiled, {
      config: runtimeConfig,
      hostVersion: "2026.6.34",
      nodeVersion: process.versions.node,
    }),
    /ACTIVE_DOMAIN_POINTER_DRIFT/,
  );

  const receipt = JSON.parse(await readFile(synced.receiptPath, "utf8"));
  receipt.index_evidence.fitness.projection_revision = `projection-${"0".repeat(64)}`;
  await writeFile(synced.receiptPath, JSON.stringify(receipt));
  current = expected;
  await assert.rejects(
    compiler.compile({
      config: runtimeConfig,
      hostVersion: "2026.6.34",
      nodeVersion: process.versions.node,
    }),
    /ACTIVE_DOMAIN_INDEX_EVIDENCE_MISMATCH/,
  );

  receipt.index_evidence.fitness.projection_revision = expected.projection_revision;
  receipt.index_evidence.fitness.desired_count = 0;
  receipt.index_evidence.fitness.indexed_count = 0;
  await writeFile(synced.receiptPath, JSON.stringify(receipt));
  await assert.rejects(
    compiler.compile({
      config: runtimeConfig,
      hostVersion: "2026.6.34",
      nodeVersion: process.versions.node,
    }),
    /ACTIVE_DOMAIN_INDEX_EVIDENCE_MISMATCH/,
  );

  receipt.index_evidence.fitness.desired_count = 1;
  receipt.index_evidence.fitness.indexed_count = 1;
  receipt.domains[0].pointer_revision = `pointer-${"6".repeat(64)}`;
  await writeFile(synced.receiptPath, JSON.stringify(receipt));
  current = expected;
  await assert.rejects(
    compiler.compile({
      config: runtimeConfig,
      hostVersion: "2026.6.34",
      nodeVersion: process.versions.node,
    }),
    /ACTIVE_DOMAIN_INPUT_MISMATCH/,
  );
});
