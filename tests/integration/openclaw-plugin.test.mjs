import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import plugin from "../../dist/openclaw/index.js";
import { calculateInstanceCutoverPlanChecksum } from "../../dist/cutover/index.js";
import {
  provenanceDatabasePath,
  SqliteProvenanceStore,
} from "../../dist/provenance/index.js";
import {
  SqliteReanswerStore,
} from "../../dist/state/index.js";
import {
  calculateCurrentStateEventChecksum,
  createStateManagementPort,
  prepareStateImportManifest,
} from "../../dist/state/management.js";
import {
  commitSyntheticPersonalDataRepository,
  commitSyntheticAuthority,
  writeSyntheticAuthority,
} from "../helpers/synthetic-authority.mjs";
import {
  jcsCanonicalJson,
  loadMaintenanceGate,
  ProjectionDeterminismLedger,
  runProjectionProducerConformance,
} from "../../dist/index.js";

class FakeCommand {
  children = new Map();
  handler;

  command(name) {
    const child = new FakeCommand();
    this.children.set(name, child);
    return child;
  }

  description() {
    return this;
  }

  action(handler) {
    this.handler = handler;
    return this;
  }

  requiredOption() {
    return this;
  }

  option() {
    return this;
  }
}

const listMarkdown = async (directory) => {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await listMarkdown(path));
    if (entry.isFile() && entry.name.endsWith(".md")) paths.push(path);
  }
  return paths;
};

test("OpenClaw discovers cognitive self-check through the plugin entry", async () => {
  const program = new FakeCommand();
  let descriptors;
  let interactiveRegistration;
  const api = {
    runtime: {
      version: "2026.7.1-2",
      llm: {
        complete: async () => {
          throw new Error("not invoked by self-check");
        },
      },
    },
    registerCli(registrar, options) {
      descriptors = options.descriptors;
      return registrar({ program });
    },
    registerInteractiveHandler(registration) {
      interactiveRegistration = registration;
    },
  };

  assert.equal(plugin.id, "cognitive-runtime");
  await plugin.register(api);
  assert.deepEqual(descriptors, [
    {
      name: "cognitive",
      description: "Inspect the cognitive runtime",
      hasSubcommands: true,
    },
  ]);
  assert.equal(interactiveRegistration?.channel, "telegram");
  assert.equal(interactiveRegistration?.namespace, "crad");
  assert.equal(typeof interactiveRegistration?.handler, "function");

  const selfCheck = program.children
    .get("cognitive")
    ?.children.get("self-check");
  assert.equal(typeof selfCheck?.handler, "function");

  const output = [];
  const originalLog = console.log;
  console.log = (value) => output.push(value);
  try {
    await selfCheck.handler();
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(output, [
    '{"status":"ok","pluginId":"cognitive-runtime","compatibilityMatrixRow":{"releaseChannel":"extended-stable","openclawVersion":"2026.7.1-2","nodeVersion":"24.18.0","evidence":"docs/evidence/openclaw-2026.7.1-2.md"},"hostCapabilities":{"hostModelCompletion":"llm.complete"}}',
  ]);
});

test("self-check rejects an unlisted Host without Runtime configuration", async () => {
  const program = new FakeCommand();
  await plugin.register({
    runtime: {
      version: "2026.6.35",
      llm: { complete: async () => ({}) },
    },
    registerCli(registrar) {
      return registrar({ program });
    },
  });
  const output = [];
  const originalLog = console.log;
  console.log = (value) => output.push(JSON.parse(value));
  try {
    await program.children.get("cognitive").children.get("self-check").handler({});
  } finally {
    console.log = originalLog;
  }

  assert.equal(output[0].status, "fail");
  assert.deepEqual(output[0].reasonCodes, ["INCOMPATIBLE_HOST"]);
});

test("OpenClaw resolves a relative cutover plan before proxying sync to Gateway", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-openclaw-sync-proxy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const capturePath = join(root, "gateway-arguments.json");
  const binaryPath = join(root, "openclaw-proxy.mjs");
  const planPath = join(root, "plan.json");
  await writeFile(planPath, "{}\n");
  await writeFile(binaryPath, [
    "#!/usr/bin/env node",
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.argv.slice(2)));`,
    'process.stdout.write(JSON.stringify({ result: { source_revision: "revision-synthetic" } }));',
  ].join("\n"));
  await chmod(binaryPath, 0o700);
  const priorOpenClawBin = process.env.OPENCLAW_BIN;
  process.env.OPENCLAW_BIN = binaryPath;
  t.after(() => {
    if (priorOpenClawBin === undefined) delete process.env.OPENCLAW_BIN;
    else process.env.OPENCLAW_BIN = priorOpenClawBin;
  });
  const program = new FakeCommand();
  await plugin.register({
    runtime: {
      version: "2026.7.1-2",
      llm: { complete: async () => ({}) },
    },
    registerGatewayMethod() {},
    registerCli(registrar) { return registrar({ program }); },
  });
  const output = [];
  const originalLog = console.log;
  console.log = (value) => output.push(JSON.parse(value));
  try {
    await program.children.get("cognitive").children.get("sync").handler({
      revision: "revision-synthetic",
      cutoverPlan: relative(process.cwd(), planPath),
      json: true,
    });
  } finally {
    console.log = originalLog;
  }
  const arguments_ = JSON.parse(await readFile(capturePath, "utf8"));
  const paramsIndex = arguments_.indexOf("--params");
  assert.notEqual(paramsIndex, -1);
  assert.deepEqual(JSON.parse(arguments_[paramsIndex + 1]), {
    sourceRevision: "revision-synthetic",
    cutoverPlanPath: planPath,
  });
  assert.equal(output[0].operation, "sync");
});

test("OpenClaw exposes validate, build, generation show, and the full sync Barrier", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-openclaw-generation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorityDirectory = join(root, "authority");
  const stateDirectory = join(root, "state");
  await writeSyntheticAuthority(authorityDirectory);
  const sourceRevision = await commitSyntheticAuthority(authorityDirectory);
  const legacyPath = join(root, "private", "30_RAG");
  const publicCorpusPath = join(root, "public-author-corpus");
  const cutoverPlanPayload = {
    schema_version: "cognitive-runtime.instance-cutover-plan/v2",
    plan_id: "cutover-canghai-public",
    instance_id: "instance-synthetic",
    target_source_revision: sourceRevision,
    publication_prerequisites: { remote_base_check: true, push_before_sync: true },
    remove_retrieval_paths: [legacyPath],
    disable_mechanisms: ["active-memory"],
    preserve_independent_paths: [publicCorpusPath],
    bootstrap_targets: ["USER.md", "MEMORY.md"],
    public_corpus_adapter: "canghai-public-corpus",
  };
  const cutoverPlan = {
    ...cutoverPlanPayload,
    checksum: calculateInstanceCutoverPlanChecksum(cutoverPlanPayload),
  };
  const cutoverPlanPath = join(root, "canghai-cutover.json");
  await writeFile(cutoverPlanPath, JSON.stringify(cutoverPlan));
  const runtimeStorage = join(root, "runtime");
  const runtimeConfig = {
    schema_version: "cognitive-runtime.instance-runtime-config/v2",
    instance_id: "instance-synthetic",
    mode: "enforce",
    runtime_storage: runtimeStorage,
    generation_storage: join(stateDirectory, "generations"),
    host: { agent_id: "main", eligible_scope: ["private_main_session"] },
    authority_owner: { provider: "telegram", actor_id: "owner-synthetic" },
    limits: { max_active_runs: 4, drain_timeout_ms: 30_000 },
    adapters: {
      authority_checkout: authorityDirectory,
      host_retrieval: "openclaw-memory",
    },
  };
  const state = createStateManagementPort({
    stateRoot: runtimeStorage,
    instanceId: runtimeConfig.instance_id,
  });
  await state.initialize();
  state.close();
  const program = new FakeCommand();
  const hooks = new Map();
  const hostConfig = {
    agents: { list: [{
      id: "main",
      memorySearch: { extraPaths: [
        join(root, "unrelated-memory"),
        legacyPath,
        publicCorpusPath,
      ] },
    }] },
  };
  let indexCalls = 0;
  let lastSearchResult;
  const cutoverEvents = [];
  const api = {
    version: "0.1.0-beta.0",
    pluginConfig: { runtime: runtimeConfig },
    runtime: {
      version: "2026.7.1-2",
      config: {
        current: () => hostConfig,
        async mutateConfigFile({ mutate }) {
          await mutate(hostConfig);
          return { result: undefined };
        },
      },
      llm: { complete: async () => ({ text: JSON.stringify({
        memory_route: "optional",
        state_refs: [],
        governing: null,
        frameworks: { primary: null, secondary: null },
        retrieval_plan: [{
          layer: "semantic",
          method: "direct_get",
          target: "sem-synthetic-claim",
          query: null,
          purpose: "Inject the activated semantic sentinel",
        }],
        confidence: 1,
        reason_codes: ["SYNTHETIC_ROUTE"],
      }) }) },
    },
    on(name, handler) { hooks.set(name, handler); },
    cognitiveRuntimeRetrievalCommands: {
      async index(agentId) {
        assert.equal(agentId, "main");
        indexCalls += 1;
      },
      async status(agentId) {
        const projectionDirectory = hostConfig.agents.list[0].memorySearch.extraPaths.at(-1);
        const files = await listMarkdown(projectionDirectory);
        return [{
          agentId,
          status: {
            backend: "builtin",
            provider: "synthetic",
            workspaceDir: projectionDirectory,
            files: files.length,
            chunks: files.length,
            dirty: false,
            extraPaths: hostConfig.agents.list[0].memorySearch.extraPaths,
            vector: {
              enabled: true,
              storeAvailable: true,
              semanticAvailable: true,
              available: true,
            },
          },
          embeddingProbe: { ok: true },
          scan: { totalFiles: files.length, issues: [] },
        }];
      },
      async search(agentId, query) {
        assert.equal(agentId, "main");
        const projectionDirectory = hostConfig.agents.list[0].memorySearch.extraPaths.at(-1);
        for (const path of await listMarkdown(projectionDirectory)) {
          const text = await readFile(path, "utf8");
          if (query.split(" ").every((term) => text.includes(term))) {
            lastSearchResult = {
              path: relative(projectionDirectory, path),
              text,
            };
            return { results: [{
              path: lastSearchResult.path,
              startLine: 1,
              endLine: text.split("\n").length,
              score: 1,
              snippet: text,
              source: "memory",
            }] };
          }
        }
        return { results: [] };
      },
      async get(agentId, path) {
        assert.equal(agentId, "main");
        assert.equal(path, lastSearchResult.path);
        return {
          path,
          text: lastSearchResult.text,
          truncated: false,
          from: 1,
          lines: lastSearchResult.text.split("\n").length,
        };
      },
    },
    cognitiveRuntimeCutoverPublication: {
      async verifyRemoteBase() { cutoverEvents.push("remote-base"); },
      async verifyPushedRevision() { cutoverEvents.push("pushed-revision"); },
    },
    cognitiveRuntimePublicCorpus: {
      async verifyBefore() {
        cutoverEvents.push("public-before");
        return {
          adapterId: "canghai-public-corpus",
          health: "pass",
          recallChecksum: `sha256:${"5".repeat(64)}`,
        };
      },
      async verifyAfter(input) {
        cutoverEvents.push("public-after");
        return {
          publicCorpus: {
            adapterId: "canghai-public-corpus",
            health: "pass",
            recallChecksum: `sha256:${"6".repeat(64)}`,
          },
          legacyPrivateHits: 0,
          privateRetrievalGenerations: [input.target.syncGeneration],
        };
      },
      async indexTarget() { cutoverEvents.push("public-index"); },
    },
    cognitiveRuntimeInstanceCutover: {
      async capture() {
        cutoverEvents.push("capture-cutover");
        return { active_memory: true, bootstrap_targets: [] };
      },
      async applyTarget(target) {
        cutoverEvents.push("apply-cutover");
        assert.deepEqual(target.bootstrapProjections.map((item) => item.target), [
          "MEMORY.md",
          "USER.md",
        ]);
      },
      async verifyTarget() { cutoverEvents.push("verify-cutover"); },
      async restore() { cutoverEvents.push("restore-cutover"); },
      async verifyPrior() { cutoverEvents.push("verify-prior-cutover"); },
    },
    registerCli(registrar) {
      return registrar({ program });
    },
  };
  await plugin.register(api);
  const cognitive = program.children.get("cognitive");
  const generation = cognitive.children.get("generation");
  const output = [];
  const originalLog = console.log;
  console.log = (value) => output.push(JSON.parse(value));
  try {
    await cognitive.children.get("validate").handler({
      authority: authorityDirectory,
      revision: sourceRevision,
      json: true,
    });
    await cognitive.children.get("build").handler({
      authority: authorityDirectory,
      state: stateDirectory,
      revision: sourceRevision,
      bootstrap: "USER.md",
      json: true,
    });
    await generation.children.get("show").handler({
      generation: output[1].sync_generation,
      state: stateDirectory,
      json: true,
    });
    await cognitive.children.get("sync").handler({
      revision: sourceRevision,
      cutoverPlan: cutoverPlanPath,
      json: true,
    });
    await generation.children.get("show").handler({ json: true });
    await cognitive.children.get("self-check").handler({});
    await cognitive.children.get("metrics").handler({ json: true });
    await cognitive.children.get("trace").children.get("lifecycle").handler({ json: true });
  } finally {
    console.log = originalLog;
  }

  assert.equal(output[0].operation, "validate");
  assert.equal(output[0].source_revision, sourceRevision);
  assert.equal(output[0].record_count, 3);
  assert.equal(output[1].operation, "build");
  assert.equal(output[1].source_revision, sourceRevision);
  assert.equal(output[1].reused, false);
  assert.deepEqual(output[1].bootstrap_projections.map((projection) => projection.target), [
    "USER.md",
  ]);
  assert.equal(output[2].operation, "generation_show");
  assert.equal(output[2].sync_generation, output[1].sync_generation);
  assert.equal(output[2].source_revision, sourceRevision);
  assert.equal(output[2].active, false);
  assert.equal(output[4].operation, "generation_show");
  assert.equal(output[4].activeSourceRevision, sourceRevision);
  assert.equal(output[4].latestSourceRevision, sourceRevision);
  assert.equal(output[4].synchronizationGap, false);
  assert.equal(output[4].pendingActivation, false);
  assert.equal(output[4].receiptValid, true);
  assert.deepEqual(output[4].reasonCodes, []);
  assert.equal(output[5].operation, "self_check");
  assert.equal(output[5].status, "pass");
  assert.equal(output[5].authorityInput.status, "pass");
  assert.equal(output[5].environment.status, "pass");
  assert.equal(output[6].operation, "metrics");
  assert.equal(output[6].health.lifecycle.pendingActivation, 1);
  assert.equal(output[6].health.lifecycle.activated, 1);
  assert.equal(output[7].operation, "trace_lifecycle");
  assert.deepEqual(output[7].traces.map((trace) => trace.outcome), [
    "pending_activation",
    "activated",
  ]);
  assert.equal(output[3].operation, "sync");
  assert.equal(output[3].source_revision, sourceRevision);
  assert.equal(output[3].sync_generation, output[1].sync_generation);
  assert.equal(output[3].reused_generation, true);
  assert.equal(output[3].cutover_plan_checksum, cutoverPlan.checksum);
  assert.equal(indexCalls, 1);
  assert.deepEqual(hostConfig.agents.list[0].memorySearch.extraPaths, [
    join(root, "unrelated-memory"),
    publicCorpusPath,
    join(
      stateDirectory,
      "generations",
      output[1].sync_generation,
      "projections",
      output[1].sync_generation,
    ),
  ]);
  assert.deepEqual(cutoverEvents, [
    "remote-base",
    "pushed-revision",
    "public-before",
    "capture-cutover",
    "apply-cutover",
    "public-index",
    "verify-cutover",
    "public-after",
  ]);
  assert.equal(
    JSON.parse(await readFile(join(runtimeStorage, "active-generation.json"), "utf8")).generation_id,
    output[1].sync_generation,
  );
  const nextRun = await hooks.get("before_prompt_build")(
    { prompt: "Use the activated Runtime", messages: [] },
    {
      runId: "run-after-sync",
      sessionKey: "agent:main:telegram:direct:owner-synthetic",
      agentId: "main",
      trigger: "user",
      messageProvider: "telegram",
      senderId: "owner-synthetic",
      chatId: "owner-synthetic",
    },
  );
  assert.match(nextRun.prependContext, /\[semantic:sem-synthetic-claim\]/);
  assert.match(nextRun.prependContext, /Synthetic claims can be tested\./);
  assert.equal(generation.children.has("activate"), false);
  assert.equal(generation.children.has("rebuild"), false);
});

test("OpenClaw sync consumes configured Fitness projection and gates domain drift", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "stella-openclaw-domain-v3-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "personal-data");
  const authorityDirectory = join(repository, "stella", "authority");
  const fitnessDirectory = join(repository, "stella", "fitness");
  const projectionRoot = join(repository, "stella", "projections");
  const fitnessProjectionRoot = join(projectionRoot, "fitness");
  const stellaProjectionRoot = join(projectionRoot, "stella");
  await writeSyntheticAuthority(authorityDirectory);
  for (const directory of [
    repository,
    join(repository, "stella"),
    authorityDirectory,
    fitnessDirectory,
    projectionRoot,
    fitnessProjectionRoot,
    stellaProjectionRoot,
  ]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  await writeFile(join(repository, ".gitignore"), "stella/projections/\n");
  const sourceRevision = await commitSyntheticPersonalDataRepository(repository);
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
  const revisionRoot = join(
    stellaProjectionRoot,
    "revisions",
    publication.projectionRevision,
  );
  await mkdir(join(revisionRoot, "payloads"), { recursive: true, mode: 0o700 });
  await chmod(join(stellaProjectionRoot, "revisions"), 0o700);
  await chmod(revisionRoot, 0o700);
  await chmod(join(revisionRoot, "payloads"), 0o700);
  await writeFile(join(revisionRoot, "manifest.json"), publication.manifestBytes, { mode: 0o600 });
  await writeFile(
    join(revisionRoot, publication.payloads[0].path),
    publication.payloads[0].bytes,
    { mode: 0o600 },
  );
  const domainPointer = {
    schema_version: "stella.context-projection-pointer/v1",
    instance_id: "instance-synthetic",
    producer_id: "stella-fitness",
    consumer_id: "stella-runtime",
    status: "active",
    pointer_revision: `pointer-${"2".repeat(64)}`,
    projection_revision: publication.projectionRevision,
    manifest_checksum: publication.manifestChecksum,
    source_revision: publication.manifest.source.revision,
    as_of: publication.manifest.source.as_of,
    changed_at: "2026-08-24T00:02:00Z",
  };
  await writeFile(
    join(stellaProjectionRoot, "active.json"),
    jcsCanonicalJson(domainPointer),
    { mode: 0o600 },
  );

  const runtimeStorage = join(root, "runtime");
  const generationStorage = join(root, "generation-state", "generations");
  const runtimeConfig = {
    schema_version: "cognitive-runtime.instance-runtime-config/v2",
    instance_id: "instance-synthetic",
    mode: "enforce",
    runtime_storage: runtimeStorage,
    generation_storage: generationStorage,
    host: { agent_id: "main", eligible_scope: ["private_main_session"] },
    authority_owner: { provider: "telegram", actor_id: "owner-synthetic" },
    limits: { max_active_runs: 4, drain_timeout_ms: 30_000 },
    adapters: { authority_checkout: authorityDirectory, host_retrieval: "openclaw-memory" },
  };
  const state = createStateManagementPort({
    stateRoot: runtimeStorage,
    instanceId: runtimeConfig.instance_id,
  });
  await state.initialize();
  state.close();
  const hostConfig = {
    plugins: {
      entries: {
        "cognitive-runtime": {
          config: {
            stella: {
              schema_version: "stella.personal-data-locator/v1",
              instance_id: "instance-synthetic",
              personal_data_repository: repository,
            },
          },
        },
      },
    },
  };
  const program = new FakeCommand();
  const hooks = new Map();
  const api = {
    version: "0.2.1-test",
    pluginConfig: { runtime: runtimeConfig },
    runtime: {
      version: "2026.7.1-2",
      config: { current: () => hostConfig },
      llm: { complete: async () => ({ text: JSON.stringify({
        memory_route: "none",
        state_refs: [],
        governing: null,
        frameworks: { primary: null, secondary: null },
        retrieval_plan: [],
        confidence: 1,
        reason_codes: ["SYNTHETIC_ROUTE"],
      }) }) },
    },
    on(name, handler) { hooks.set(name, handler); },
    cognitiveRuntimeHostTransition: {
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
          domains: target.domainIndexes.map((domain) => ({
            domainId: domain.domain_id,
            projectionRevision: domain.projection_revision,
            manifestChecksum: domain.manifest_checksum,
            desiredCount: domain.desired_count,
            indexedCount: domain.desired_count,
            previousRevision: target.previousDomainIndexes.find(({ domain_id }) =>
              domain_id === domain.domain_id)?.projection_revision ?? null,
            previousStableIdHits: 0,
            previousTextSentinelHits: 0,
            previousSourceReferenceHits: 0,
          })),
        };
      },
      async restore() {},
      async verifyPrior() { throw new Error("UNEXPECTED_PRIOR_VERIFY"); },
    },
    registerCli(registrar) { return registrar({ program }); },
  };
  await plugin.register(api);
  const output = [];
  const originalLog = console.log;
  console.log = (value) => output.push(JSON.parse(value));
  try {
    await program.children.get("cognitive").children.get("sync").handler({
      revision: sourceRevision,
      json: true,
    });
  } finally {
    console.log = originalLog;
  }
  const pointer = JSON.parse(await readFile(join(runtimeStorage, "active-generation.json"), "utf8"));
  assert.equal(pointer.schema_version, "cognitive-runtime.active-generation-pointer/v3");
  assert.equal(pointer.domains[0].projection_revision, publication.projectionRevision);

  const context = {
    runId: "run-domain-v3",
    sessionKey: "agent:main:telegram:direct:owner-synthetic",
    agentId: "main",
    trigger: "user",
    messageProvider: "telegram",
    senderId: "owner-synthetic",
    chatId: "owner-synthetic",
  };
  await hooks.get("before_prompt_build")({ prompt: "Use context", messages: [] }, context);
  await writeFile(join(stellaProjectionRoot, "active.json"), jcsCanonicalJson({
    schema_version: "stella.context-projection-pointer/v1",
    instance_id: "instance-synthetic",
    producer_id: "stella-fitness",
    consumer_id: "stella-runtime",
    status: "blocked",
    pointer_revision: `pointer-${"5".repeat(64)}`,
    source_revision: "fitness-f2",
    changed_at: "2026-08-24T00:03:00Z",
    reason_codes: ["CORRECTION_PENDING"],
  }), { mode: 0o600 });
  const barrier = await hooks.get("before_agent_run")(
    { prompt: "Use context", messages: [] },
    context,
  );
  assert.equal(barrier.outcome, "block");
  assert.equal(barrier.metadata.reasonCode, "ACTIVE_DOMAIN_PROJECTION_UNAVAILABLE");
  assert.equal(
    (await loadMaintenanceGate(runtimeStorage))?.targetSourceRevision,
    sourceRevision,
  );
});

test("OpenClaw registration does not use rejected host paths", async () => {
  const rejected = [
    "runContext",
    "enqueueNextTurnInjection",
    "runEmbeddedAgent",
    "scheduleSessionTurn",
  ];
  const rejectAccess = (target) => new Proxy(target, {
    get(value, property, receiver) {
      assert.equal(rejected.includes(String(property)), false);
      return Reflect.get(value, property, receiver);
    },
  });
  const api = rejectAccess({
    runtime: rejectAccess({
      llm: rejectAccess({ complete: async () => ({}) }),
      workflow: rejectAccess({}),
    }),
    registerCli() {},
  });

  await plugin.register(api);
});

test("self-check fails Plugin discovery when the Host cannot register hooks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-openclaw-no-hooks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorityDirectory = join(root, "authority");
  await writeSyntheticAuthority(authorityDirectory);
  await commitSyntheticAuthority(authorityDirectory);
  const runtimeStorage = join(root, "runtime");
  await mkdir(runtimeStorage, { recursive: true });
  const program = new FakeCommand();
  await plugin.register({
    version: "0.2.0-test",
    pluginConfig: { runtime: {
      schema_version: "cognitive-runtime.instance-runtime-config/v2",
      instance_id: "instance-no-hooks",
      mode: "observe",
      runtime_storage: runtimeStorage,
      generation_storage: join(root, "generations"),
      host: { agent_id: "main", eligible_scope: ["private_main_session"] },
      authority_owner: { provider: "telegram", actor_id: "owner-synthetic" },
      limits: { max_active_runs: 4, drain_timeout_ms: 30_000 },
      adapters: { authority_checkout: authorityDirectory, host_retrieval: "synthetic" },
    } },
    runtime: {
      version: "2026.7.1-2",
      llm: { complete: async () => ({ text: "{}" }) },
      config: { current: () => ({ agents: { list: [] } }) },
    },
    cognitiveRuntimeHostTransition: {
      async capture() { return {}; },
      async applyTarget() {},
      async verifyTarget() { throw new Error("ACTIVE_GENERATION_UNAVAILABLE"); },
      async restore() {},
      async verifyPrior() { throw new Error("ACTIVE_GENERATION_UNAVAILABLE"); },
    },
    registerCli(registrar) { return registrar({ program }); },
  });
  const output = [];
  const originalLog = console.log;
  console.log = (value) => output.push(JSON.parse(value));
  try {
    await program.children.get("cognitive").children.get("self-check").handler({});
  } finally {
    console.log = originalLog;
  }
  const discovery = output[0].environment.checks.find((check) =>
    check.id === "plugin_discovery");
  assert.deepEqual(discovery, {
    id: "plugin_discovery",
    status: "fail",
    reasonCodes: ["PLUGIN_DISCOVERY_FAILED"],
  });
});

test("OpenClaw plugin rejects Telegram registration on an unsmoked Host", async () => {
  assert.throws(
    () => plugin.register({
      runtime: {
        version: "2026.6.35",
        llm: { complete: async () => ({}) },
      },
      registerInteractiveHandler() {},
      registerCli() {},
    }),
    /TELEGRAM_CONFIRMATION_HOST_UNSUPPORTED/,
  );
});

test("OpenClaw startup attempts interrupted sync recovery and keeps admission closed on failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-openclaw-sync-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeStorage = join(root, "runtime");
  await mkdir(runtimeStorage, { recursive: true });
  await writeFile(join(runtimeStorage, "maintenance-gate.json"), JSON.stringify({
    target_source_revision: "b".repeat(40),
    closed_at: "2026-08-17T00:00:00.000Z",
  }));
  await writeFile(join(runtimeStorage, "sync-journal.json"), JSON.stringify({
    target_source_revision: "b".repeat(40),
    sync_generation: `generation-${"b".repeat(64)}`,
    prior: {
      config_revision: "prior",
      cutover_state: { active_memory: true, bootstrap_targets: ["USER.md"] },
    },
    prior_pointer: { invalid: "pointer" },
    started_at: "2026-08-17T00:00:00.000Z",
    phase: "host_applied",
  }));
  const hooks = new Map();
  const logs = [];
  let restoreCalls = 0;
  await plugin.register({
    version: "0.2.0-test",
    pluginConfig: { runtime: {
      schema_version: "cognitive-runtime.instance-runtime-config/v2",
      instance_id: "instance-synthetic",
      mode: "enforce",
      runtime_storage: runtimeStorage,
      generation_storage: join(root, "generations"),
      host: { agent_id: "main", eligible_scope: ["private_main_session"] },
      authority_owner: { provider: "telegram", actor_id: "owner-synthetic" },
      limits: { max_active_runs: 4, drain_timeout_ms: 30_000 },
      adapters: { authority_checkout: join(root, "authority"), host_retrieval: "openclaw-memory" },
    } },
    runtime: { version: "2026.7.1-2", llm: { complete: async () => ({}) } },
    on(name, handler) { hooks.set(name, handler); },
    logger: { info() {}, warn(message) { logs.push(JSON.parse(message)); } },
    cognitiveRuntimeHostTransition: {
      async capture() { return {}; },
      async applyTarget() {},
      async verifyTarget() { throw new Error("UNEXPECTED_TARGET_VERIFY"); },
      async restore(snapshot) {
        restoreCalls += 1;
        assert.deepEqual(snapshot.cutover_state, {
          active_memory: true,
          bootstrap_targets: ["USER.md"],
        });
      },
      async verifyPrior() { throw new Error("UNEXPECTED_PRIOR_VERIFY"); },
    },
    registerCli() {},
  });

  for (let attempt = 0; logs.length === 0 && attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(restoreCalls, 1);
  assert.ok(logs.some((entry) => entry.reasonCode === "SYNC_RECOVERY_FAILED"));
  await assert.rejects(
    hooks.get("before_prompt_build")(
      { prompt: "blocked", messages: [] },
      {
        runId: "run-startup-blocked",
        sessionKey: "agent:main:telegram:direct:owner-synthetic",
        agentId: "main",
        trigger: "user",
        messageProvider: "telegram",
        senderId: "owner-synthetic",
        chatId: "owner-synthetic",
      },
    ),
    /COGNITIVE_BINDING_REJECTED:MAINTENANCE_GATE_CLOSED/,
  );
});

test("OpenClaw startup rejects an unlisted exact Host without Host mutation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-openclaw-incompatible-startup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hooks = new Map();
  const logs = [];
  const hostMutations = [];

  await plugin.register({
    version: "0.2.0-test",
    pluginConfig: { runtime: {
      schema_version: "cognitive-runtime.instance-runtime-config/v2",
      instance_id: "instance-synthetic",
      mode: "enforce",
      runtime_storage: join(root, "runtime"),
      generation_storage: join(root, "generations"),
      host: { agent_id: "main", eligible_scope: ["private_main_session"] },
      authority_owner: { provider: "telegram", actor_id: "owner-synthetic" },
      limits: { max_active_runs: 4, drain_timeout_ms: 30_000 },
      adapters: {
        authority_checkout: join(root, "authority"),
        host_retrieval: "openclaw-memory",
      },
    } },
    runtime: {
      version: "2026.6.35",
      llm: { complete: async () => ({}) },
    },
    on(name, handler) { hooks.set(name, handler); },
    logger: { info() {}, warn(message) { logs.push(JSON.parse(message)); } },
    cognitiveRuntimeHostTransition: {
      async capture() { hostMutations.push("capture"); return {}; },
      async applyTarget() { hostMutations.push("apply"); },
      async verifyTarget() { hostMutations.push("verify"); throw new Error("UNEXPECTED_VERIFY"); },
      async restore() { hostMutations.push("restore"); },
      async verifyPrior() { hostMutations.push("verify-prior"); throw new Error("UNEXPECTED_VERIFY"); },
    },
    registerCli() {},
  });

  for (let attempt = 0; logs.length === 0 && attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.deepEqual(hostMutations, []);
  assert.ok(logs.some((entry) => entry.reasonCode === "INCOMPATIBLE_HOST"));
  await assert.rejects(
    hooks.get("before_prompt_build")(
      { prompt: "blocked", messages: [] },
      {
        runId: "run-incompatible-startup",
        sessionKey: "agent:main:telegram:direct:owner-synthetic",
        agentId: "main",
        trigger: "user",
        messageProvider: "telegram",
        senderId: "owner-synthetic",
        chatId: "owner-synthetic",
      },
    ),
    /COGNITIVE_BINDING_REJECTED:MAINTENANCE_GATE_CLOSED/,
  );
});

test("OpenClaw recovery commands expose backup, read-only verify, and restore JSON", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-openclaw-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, "state");
  const sourceDirectory = join(stateRoot, "instance-synthetic");
  await mkdir(sourceDirectory, { recursive: true });
  const store = new SqliteReanswerStore({
    databasePath: join(sourceDirectory, "runtime.sqlite"),
    initialHead: {
      active_seq: 0,
      view_version: "view-synthetic-0",
      checksum: `sha256:${"0".repeat(64)}`,
      activated_at: "2026-08-11T00:00:00.000Z",
    },
  });
  store.close();
  const program = new FakeCommand();
  const api = {
    version: "0.0.0",
    pluginConfig: {
      recovery: {
        stateRoot,
        activeInstanceId: "instance-synthetic",
        instances: {
          "instance-synthetic": {
            authorityRevision: "revision-synthetic-1",
          },
        },
      },
    },
    runtime: { llm: { complete: async () => ({}) } },
    on(event, handler) {
      this.hooks ??= new Map();
      this.hooks.set(event, handler);
    },
    registerCli(registrar) {
      return registrar({ program });
    },
  };
  await plugin.register(api);
  const cognitive = program.children.get("cognitive");
  const output = [];
  const originalLog = console.log;
  console.log = (value) => output.push(JSON.parse(value));
  try {
    const snapshotDirectory = join(root, "snapshot");
    await cognitive.children.get("backup").handler({
      instance: "instance-synthetic",
      output: snapshotDirectory,
      json: true,
    });
    await cognitive.children.get("verify").handler({
      snapshot: snapshotDirectory,
      json: true,
    });
    await rm(sourceDirectory, { recursive: true, force: true });
    await cognitive.children.get("restore").handler({
      instance: "instance-synthetic",
      snapshot: snapshotDirectory,
      json: true,
    });
    await api.hooks.get("before_prompt_build")({}, {
      runId: "run-synthetic-after-restore",
    });
    await cognitive.children.get("restore").handler({
      instance: "instance-synthetic",
      snapshot: snapshotDirectory,
      json: true,
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(output[0].operation, "backup");
  assert.match(output[0].artifact_id, /^sha256:[a-f0-9]{64}$/);
  assert.equal(output[1].operation, "verify");
  assert.equal(output[1].integrity_result.status, "pass");
  assert.equal(output[2].operation, "restore");
  assert.equal(output[2].restored_active_head.active_seq, 0);
  assert.equal("live_database_path" in output[2], false);
  assert.equal(output[3].compatibility_result.status, "fail");
  assert.ok(
    output[3].compatibility_result.reason_codes.includes("TARGET_HAS_SERVED_RUN"),
  );
});

test("OpenClaw cognitive state and trace get/query return structured read-only results", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-openclaw-inspect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, "state");
  const instanceId = "instance-synthetic";
  const instanceDirectory = join(stateRoot, instanceId);
  await mkdir(instanceDirectory, { recursive: true });
  const state = new SqliteReanswerStore({
    databasePath: join(instanceDirectory, "runtime.sqlite"),
    instanceId,
    initialHead: {
      active_seq: 0,
      view_version: "view-synthetic-0",
      checksum: `sha256:${"0".repeat(64)}`,
      activated_at: "2026-08-11T00:00:00.000Z",
    },
  });
  await state.correct({
    event: {
      seq: 1,
      event_id: "event-synthetic-1",
      state_id: "state-synthetic",
      event_type: "correction",
      payload: { value: "synthetic" },
      observed_at: "2026-08-11T00:00:01.000Z",
      source_kind: "user_explicit",
      idempotency_key: "event-key-synthetic-1",
      created_at: "2026-08-11T00:00:01.000Z",
    },
    outbox: {
      correctionId: "correction-synthetic-1",
      instanceId,
      sessionKeyHash: `sha256:${"1".repeat(64)}`,
      priorRunId: "run-prior-synthetic",
      idempotencyKey: "outbox-key-synthetic-1",
      createdAt: "2026-08-11T00:00:01.000Z",
    },
  });
  state.close();
  const provenance = new SqliteProvenanceStore({
    databasePath: provenanceDatabasePath(stateRoot, instanceId),
  });
  await provenance.record({
    trace_id: "trace-synthetic-1",
    run_id: "run-synthetic-1",
    session_key_hash: `sha256:${"1".repeat(64)}`,
    sync_generation: "generation-synthetic-1",
    knowledge_snapshot: "revision-synthetic-1",
    state_view_version: "state-view-synthetic-1",
    validated_router_result: null,
    cognitive_bindings: [],
    stable_refs: [{ id: "state-synthetic", status: "injected" }],
    unresolved_conflicts: [],
    trace_status: "completed",
    eval_eligible: true,
    created_at: "2026-08-11T00:00:02.000Z",
  });
  provenance.close();

  const program = new FakeCommand();
  const api = {
    pluginConfig: {
      recovery: {
        stateRoot,
        activeInstanceId: instanceId,
        instances: {
          [instanceId]: { authorityRevision: "revision-synthetic-1" },
        },
      },
    },
    runtime: { llm: { complete: async () => ({}) } },
    on() {},
    registerCli(registrar) { return registrar({ program }); },
  };
  await plugin.register(api);
  const cognitive = program.children.get("cognitive");
  const output = [];
  const originalLog = console.log;
  console.log = (value) => output.push(JSON.parse(value));
  try {
    await cognitive.children.get("state").children.get("view").handler({
      instance: instanceId,
      revision: "1",
      json: true,
    });
    await cognitive.children.get("trace").children.get("get").handler({
      instance: instanceId,
      trace: "trace-synthetic-1",
      json: true,
    });
    await cognitive.children.get("trace").children.get("query").handler({
      instance: instanceId,
      status: "completed",
      ref: "state-synthetic",
      limit: "10",
      json: true,
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(output[0].operation, "state_view");
  assert.equal(output[0].view.active_seq, 1);
  assert.equal(output[0].view.values[0].value, "synthetic");
  assert.equal(output[1].operation, "trace_get");
  assert.equal(output[1].trace.trace_id, "trace-synthetic-1");
  assert.equal(output[2].operation, "trace_query");
  assert.deepEqual(output[2].traces.map((trace) => trace.trace_id), [
    "trace-synthetic-1",
  ]);
});

test("OpenClaw state initialize/import/view/correct expose the formal JSON workflow", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-openclaw-state-operations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, "state");
  const instanceId = "instance-operations";
  const program = new FakeCommand();
  await plugin.register({
    pluginConfig: {
      recovery: {
        stateRoot,
        activeInstanceId: instanceId,
        instances: { [instanceId]: { authorityRevision: "revision-synthetic-1" } },
      },
    },
    runtime: { llm: { complete: async () => ({}) } },
    registerCli(registrar) { return registrar({ program }); },
  });
  const state = program.children.get("cognitive").children.get("state");
  const output = [];
  const originalLog = console.log;
  console.log = (value) => output.push(JSON.parse(value));
  try {
    await state.children.get("initialize").handler({ instance: instanceId, json: true });
    const helper = createStateManagementPort({ stateRoot, instanceId });
    const baselineEvent = {
      seq: 1,
      event_id: "event-cli-baseline-1",
      state_id: "state-cli-location",
      event_type: "imported_baseline",
      payload: { value: "Shanghai", prior_history: "unknown" },
      observed_at: "2026-08-14T00:00:00.000Z",
      source_kind: "user_confirmed",
      source_ref: "confirmation-cli-1",
      idempotency_key: "event-cli-baseline-key-1",
      created_at: "2026-08-14T00:00:00.000Z",
    };
    const manifest = await prepareStateImportManifest(helper, {
      importId: "import-cli-1",
      events: [baselineEvent],
      sourceMappings: [{
        event_id: baselineEvent.event_id,
        source_kind: "user_confirmed",
        source_ref: baselineEvent.source_ref,
        verification: "Exact value confirmed at cutover",
      }],
      createdAt: "2026-08-14T00:00:00.000Z",
    });
    helper.close();
    const manifestPath = join(root, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    const authorizationPath = join(root, "authorization.json");
    await writeFile(authorizationPath, JSON.stringify({
      authorizations: [{
        eventId: baselineEvent.event_id,
        eventChecksum: calculateCurrentStateEventChecksum(baselineEvent),
        sourceKind: "user_confirmed",
        sourceRef: baselineEvent.source_ref,
        verification: "Exact value confirmed at cutover",
        verifiedAt: new Date().toISOString(),
      }],
      max_authorization_age_ms: 60_000,
    }), "utf8");
    await state.children.get("import").handler({
      instance: instanceId,
      manifest: manifestPath,
      authorization: authorizationPath,
      json: true,
    });
    await state.children.get("view").handler({ instance: instanceId, json: true });

    const correctionEventPath = join(root, "correction-event.json");
    await writeFile(correctionEventPath, JSON.stringify({
      ...baselineEvent,
      seq: 2,
      event_id: "event-cli-correction-2",
      event_type: "correction",
      payload: { value: "Hangzhou" },
      source_ref: undefined,
      idempotency_key: "event-cli-correction-key-2",
    }), "utf8");
    await state.children.get("correct").children.get("plan").handler({
      instance: instanceId,
      preview: "preview-cli-2",
      event: correctionEventPath,
      expires: "2099-08-15T00:00:00.000Z",
      json: true,
    });
    const previewPath = join(root, "preview.json");
    await writeFile(previewPath, JSON.stringify(output.at(-1).preview), "utf8");
    await state.children.get("correct").children.get("apply").handler({
      instance: instanceId,
      preview: previewPath,
      checksum: output.at(-1).preview.preview_checksum,
      correction: "correction-cli-2",
      session: `sha256:${"5".repeat(64)}`,
      priorRun: "run-cli-prior-2",
      idempotencyKey: "outbox-cli-key-2",
      json: true,
    });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(output.map((entry) => entry.operation), [
    "state_initialize",
    "state_import",
    "state_view",
    "state_correct_plan",
    "state_correct_apply",
  ]);
  assert.equal(output[2].view.values[0].value, "Shanghai");
  assert.equal(output[4].view.values[0].value, "Hangzhou");
});
