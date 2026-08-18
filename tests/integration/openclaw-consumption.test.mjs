import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import {
  OpenClawCliRetrievalCommands,
  OpenClawGenerationConsumptionAdapter,
} from "../../dist/openclaw/consumption.js";
import { buildGeneration } from "../../dist/generation/index.js";
import {
  commitSyntheticAuthority,
  writeSyntheticAuthority,
} from "../helpers/synthetic-authority.mjs";

const checksum = (value) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const runtimeConfig = (root) => ({
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
});

const syncTarget = (config, projectionDirectory) => ({
  config,
  sourceRevision: "a".repeat(40),
  syncGeneration: `generation-${"b".repeat(64)}`,
  generationDirectory: join(config.generation_storage, `generation-${"b".repeat(64)}`),
  projectionDirectory,
  manifestChecksum: `sha256:${"1".repeat(64)}`,
  projectionChecksum: `sha256:${"2".repeat(64)}`,
  hostConfigChecksum: `sha256:${"3".repeat(64)}`,
});

test("OpenClaw adapter replaces only this instance managed path and forces indexing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-openclaw-consumption-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = runtimeConfig(root);
  await mkdir(config.runtime_storage, { recursive: true });
  const oldManagedPath = join(root, "old-managed-projection");
  const unrelatedPath = join(root, "public-author-corpus");
  const otherAgentPath = join(root, "other-agent-memory");
  await writeFile(join(config.runtime_storage, "retrieval-paths.json"), JSON.stringify({
    schema_version: "cognitive-runtime.retrieval-path-ownership/v1",
    instance_id: config.instance_id,
    agent_id: config.host.agent_id,
    paths: [oldManagedPath],
  }));
  const hostConfig = {
    agents: {
      list: [
        { id: "main", memorySearch: { extraPaths: [unrelatedPath, oldManagedPath] } },
        { id: "other", memorySearch: { extraPaths: [otherAgentPath] } },
      ],
    },
  };
  const mutations = [];
  const commands = [];
  const adapter = new OpenClawGenerationConsumptionAdapter(config, {
    config: {
      current: () => hostConfig,
      async mutateConfigFile({ afterWrite, mutate }) {
        mutations.push(afterWrite);
        await mutate(hostConfig);
        return { result: undefined };
      },
    },
  }, {
    async index(agentId) { commands.push(["index", agentId]); },
    async status() { throw new Error("UNEXPECTED_STATUS"); },
    async search() { throw new Error("UNEXPECTED_SEARCH"); },
    async get() { throw new Error("UNEXPECTED_GET"); },
  });
  const target = syncTarget(config, join(root, "new-managed-projection"));

  const snapshot = await adapter.capture();
  await adapter.applyTarget(target);

  assert.deepEqual(snapshot, {
    instance_id: config.instance_id,
    agent_id: "main",
    extra_paths: [unrelatedPath, oldManagedPath],
    managed_paths: [oldManagedPath],
  });
  assert.deepEqual(hostConfig.agents.list[0].memorySearch.extraPaths, [
    unrelatedPath,
    target.projectionDirectory,
  ]);
  assert.deepEqual(hostConfig.agents.list[1].memorySearch.extraPaths, [otherAgentPath]);
  assert.deepEqual(mutations, [{ mode: "auto" }]);
  assert.deepEqual(commands, [["index", "main"]]);
  assert.deepEqual(
    JSON.parse(await readFile(join(config.runtime_storage, "retrieval-paths.json"), "utf8")),
    {
      schema_version: "cognitive-runtime.retrieval-path-ownership/v1",
      instance_id: config.instance_id,
      agent_id: "main",
      paths: [target.projectionDirectory],
    },
  );
});

test("OpenClaw adapter applies and restores declared legacy, mechanism, and Bootstrap transitions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-openclaw-cutover-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = runtimeConfig(root);
  await mkdir(config.runtime_storage, { recursive: true });
  const legacyPath = join(root, "private", "30_RAG");
  const publicPath = join(root, "public-author-corpus");
  const oldManagedPath = join(root, "old-managed");
  const projectionDirectory = join(root, "new-managed");
  await writeFile(join(config.runtime_storage, "retrieval-paths.json"), JSON.stringify({
    schema_version: "cognitive-runtime.retrieval-path-ownership/v1",
    instance_id: config.instance_id,
    agent_id: config.host.agent_id,
    paths: [oldManagedPath],
  }));
  const hostConfig = {
    agents: { list: [{
      id: "main",
      memorySearch: { extraPaths: [legacyPath, publicPath, oldManagedPath] },
    }] },
  };
  const cutoverEvents = [];
  const plan = {
    schema_version: "cognitive-runtime.instance-cutover-plan/v2",
    plan_id: "cutover-canghai-public",
    instance_id: config.instance_id,
    target_source_revision: "a".repeat(40),
    publication_prerequisites: { remote_base_check: true, push_before_sync: true },
    remove_retrieval_paths: [legacyPath],
    disable_mechanisms: ["active-memory"],
    preserve_independent_paths: [publicPath],
    bootstrap_targets: ["USER.md", "MEMORY.md"],
    public_corpus_adapter: "canghai-public-corpus",
    checksum: `sha256:${"4".repeat(64)}`,
  };
  const target = {
    ...syncTarget(config, projectionDirectory),
    cutover: {
      plan,
      bootstrapProjections: [
        { target: "MEMORY.md", path: join(root, "bootstrap", "MEMORY.md"), checksum: checksum("m"), reused: false },
        { target: "USER.md", path: join(root, "bootstrap", "USER.md"), checksum: checksum("u"), reused: false },
      ],
    },
  };
  const adapter = new OpenClawGenerationConsumptionAdapter(config, {
    config: {
      current: () => hostConfig,
      async mutateConfigFile({ mutate }) {
        await mutate(hostConfig);
        return { result: undefined };
      },
    },
  }, {
    async index() { cutoverEvents.push("index"); },
    async status() { throw new Error("UNEXPECTED_STATUS"); },
    async search() { throw new Error("UNEXPECTED_SEARCH"); },
    async get() { throw new Error("UNEXPECTED_GET"); },
  }, {
    async capture(input) {
      cutoverEvents.push("capture-cutover");
      assert.equal(input.plan.checksum, plan.checksum);
      return { active_memory: true, bootstrap: [] };
    },
    async applyTarget(input) {
      cutoverEvents.push("apply-cutover");
      assert.equal(input.plan.disable_mechanisms[0], "active-memory");
      assert.deepEqual(input.bootstrapProjections.map((item) => item.target), ["MEMORY.md", "USER.md"]);
    },
    async verifyTarget() { cutoverEvents.push("verify-cutover"); },
    async restore() { cutoverEvents.push("restore-cutover"); },
    async verifyPrior() { cutoverEvents.push("verify-prior-cutover"); },
  });

  const snapshot = await adapter.capture(target);
  await adapter.applyTarget(target);

  assert.deepEqual(hostConfig.agents.list[0].memorySearch.extraPaths, [
    publicPath,
    projectionDirectory,
  ]);
  assert.deepEqual(cutoverEvents, ["capture-cutover", "apply-cutover", "index"]);
  assert.deepEqual(snapshot.cutover_state, { active_memory: true, bootstrap: [] });

  await adapter.restore(snapshot);
  assert.deepEqual(hostConfig.agents.list[0].memorySearch.extraPaths, [
    legacyPath,
    publicPath,
    oldManagedPath,
  ]);
  assert.deepEqual(cutoverEvents, [
    "capture-cutover",
    "apply-cutover",
    "index",
    "restore-cutover",
    "index",
  ]);
});

test("OpenClaw adapter rejects a cutover without a recoverable consumer snapshot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-openclaw-cutover-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = runtimeConfig(root);
  await mkdir(config.runtime_storage, { recursive: true });
  const hostConfig = {
    agents: { list: [{ id: "main", memorySearch: { extraPaths: [] } }] },
  };
  const adapter = new OpenClawGenerationConsumptionAdapter(config, {
    config: {
      current: () => hostConfig,
      async mutateConfigFile() { throw new Error("UNEXPECTED_MUTATION"); },
    },
  }, {
    async index() { throw new Error("UNEXPECTED_INDEX"); },
    async status() { throw new Error("UNEXPECTED_STATUS"); },
    async search() { throw new Error("UNEXPECTED_SEARCH"); },
    async get() { throw new Error("UNEXPECTED_GET"); },
  }, {
    async capture() { return undefined; },
    async applyTarget() { throw new Error("UNEXPECTED_APPLY"); },
    async verifyTarget() { throw new Error("UNEXPECTED_VERIFY"); },
    async restore() { throw new Error("UNEXPECTED_RESTORE"); },
    async verifyPrior() { throw new Error("UNEXPECTED_PRIOR_VERIFY"); },
  });
  const target = {
    ...syncTarget(config, join(root, "projection")),
    cutover: {
      plan: {
        schema_version: "cognitive-runtime.instance-cutover-plan/v2",
        plan_id: "cutover-synthetic",
        instance_id: config.instance_id,
        target_source_revision: "a".repeat(40),
        publication_prerequisites: { remote_base_check: false, push_before_sync: false },
        remove_retrieval_paths: [],
        disable_mechanisms: ["active-memory"],
        preserve_independent_paths: [],
        bootstrap_targets: [],
        checksum: `sha256:${"4".repeat(64)}`,
      },
      bootstrapProjections: [],
    },
  };

  await assert.rejects(adapter.capture(target), /OPENCLAW_CUTOVER_SNAPSHOT_INVALID/);
  assert.deepEqual(hostConfig.agents.list[0].memorySearch.extraPaths, []);
});

test("OpenClaw adapter proves deep status plus bound search and get sentinels", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-openclaw-sentinel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = runtimeConfig(root);
  await writeSyntheticAuthority(config.adapters.authority_checkout);
  const sourceRevision = await commitSyntheticAuthority(config.adapters.authority_checkout);
  const built = await buildGeneration({
    authorityDirectory: config.adapters.authority_checkout,
    stateDirectory: root,
    generationsDirectory: config.generation_storage,
    sourceRevision,
    packageVersion: "0.2.0-test",
  });
  const projectionArtifact = JSON.parse(await readFile(
    join(built.generationDirectory, "projection-entries.json"),
    "utf8",
  ));
  const sentinel = [...projectionArtifact.payload.entries]
    .sort((left, right) => left.stable_id.localeCompare(right.stable_id))[0];
  const documentRelativePath = built.manifest.files
    .map((file) => file.path)
    .find((path) => path.includes(`/${sentinel.stable_id}/`) && path.endsWith(".md"));
  const projectionRelativePath = documentRelativePath
    .slice(`projections/${built.syncGeneration}/`.length);
  const workspaceRelativePath = relative(root, join(
    built.generationDirectory,
    documentRelativePath,
  ));
  const document = await readFile(join(built.generationDirectory, documentRelativePath), "utf8");
  const target = {
    ...syncTarget(config, join(
      built.generationDirectory,
      "projections",
      built.syncGeneration,
    )),
    sourceRevision,
    syncGeneration: built.syncGeneration,
    generationDirectory: built.generationDirectory,
    projectionChecksum: built.manifest.files.find(
      (file) => file.path === "projection-entries.json",
    ).checksum,
  };
  let staleSearch = false;
  let searchPath = workspaceRelativePath;
  let statusPatch = {};
  const adapter = new OpenClawGenerationConsumptionAdapter(config, {
    config: {
      current: () => ({
        agents: { list: [{ id: "main", memorySearch: { extraPaths: [target.projectionDirectory] } }] },
      }),
      async mutateConfigFile() { throw new Error("UNEXPECTED_MUTATION"); },
    },
  }, {
    async index() { throw new Error("UNEXPECTED_INDEX"); },
    async status(agentId) {
      return [{
        agentId,
        status: {
          backend: "builtin",
          provider: "synthetic",
          workspaceDir: root,
          files: projectionArtifact.payload.entries.length,
          chunks: projectionArtifact.payload.entries.length,
          dirty: false,
          extraPaths: [target.projectionDirectory],
          vector: {
            enabled: true,
            storeAvailable: true,
            semanticAvailable: true,
            available: true,
          },
          ...statusPatch,
        },
        embeddingProbe: { ok: true },
        scan: { totalFiles: projectionArtifact.payload.entries.length, issues: [] },
      }];
    },
    async search(agentId, query) {
      assert.equal(agentId, "main");
      assert.match(query, new RegExp(sentinel.stable_id));
      assert.match(query, new RegExp(built.syncGeneration));
      return {
        results: [{
          path: searchPath,
          startLine: 1,
          endLine: document.split("\n").length,
          score: 0.99,
          snippet: staleSearch
            ? document.replace(built.syncGeneration, `generation-${"f".repeat(64)}`)
            : document,
          source: "memory",
        }],
      };
    },
    async get(agentId, path) {
      assert.equal(agentId, "main");
      assert.equal(path, workspaceRelativePath);
      return {
        path,
        text: document,
        truncated: false,
        from: 1,
        lines: document.split("\n").length,
      };
    },
  });

  const evidence = await adapter.verifyTarget(target);

  assert.deepEqual(evidence, {
    deepStatus: "pass",
    generationId: built.syncGeneration,
    sourceRevision,
    projectionChecksum: target.projectionChecksum,
    hostConfigChecksum: target.hostConfigChecksum,
    searchSentinelChecksum: checksum(JSON.stringify({
      path: workspaceRelativePath,
      start_line: 1,
      end_line: document.split("\n").length,
      snippet: document,
    })),
    getSentinelChecksum: checksum(JSON.stringify({
      path: workspaceRelativePath,
      text: document,
      from: 1,
      lines: document.split("\n").length,
    })),
  });

  staleSearch = true;
  await assert.rejects(
    adapter.verifyTarget(target),
    /OPENCLAW_SEARCH_SENTINEL_IDENTITY_MISMATCH/,
  );

  staleSearch = false;
  searchPath = join("unrelated", projectionRelativePath);
  await assert.rejects(
    adapter.verifyTarget(target),
    /OPENCLAW_SEARCH_SENTINEL_MISSING/,
  );

  searchPath = workspaceRelativePath;
  statusPatch = { dirty: undefined };
  await assert.rejects(
    adapter.verifyTarget(target),
    /OPENCLAW_DEEP_STATUS_FAILED/,
  );

  statusPatch = {
    dirty: false,
    chunks: 0,
    vector: {
      enabled: true,
      storeAvailable: true,
      semanticAvailable: false,
      available: false,
    },
  };
  await assert.rejects(
    adapter.verifyTarget(target),
    /OPENCLAW_DEEP_STATUS_FAILED/,
  );
});

test("OpenClaw adapter restores prior ownership without deleting newly unrelated paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-openclaw-restore-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = runtimeConfig(root);
  await mkdir(config.runtime_storage, { recursive: true });
  const priorManaged = join(root, "prior-managed");
  const currentManaged = join(root, "failed-target-managed");
  const originalUnrelated = join(root, "original-unrelated");
  const newUnrelated = join(root, "new-unrelated");
  await writeFile(join(config.runtime_storage, "retrieval-paths.json"), JSON.stringify({
    schema_version: "cognitive-runtime.retrieval-path-ownership/v1",
    instance_id: config.instance_id,
    agent_id: "main",
    paths: [currentManaged],
  }));
  const hostConfig = {
    agents: { list: [{
      id: "main",
      memorySearch: { extraPaths: [originalUnrelated, currentManaged, newUnrelated] },
    }] },
  };
  const indexed = [];
  const adapter = new OpenClawGenerationConsumptionAdapter(config, {
    config: {
      current: () => hostConfig,
      async mutateConfigFile({ mutate }) {
        await mutate(hostConfig);
        return { result: undefined };
      },
    },
  }, {
    async index(agentId) { indexed.push(agentId); },
    async status() { throw new Error("UNEXPECTED_STATUS"); },
    async search() { throw new Error("UNEXPECTED_SEARCH"); },
    async get() { throw new Error("UNEXPECTED_GET"); },
  });

  await adapter.restore({
    instance_id: config.instance_id,
    agent_id: "main",
    extra_paths: [originalUnrelated, priorManaged],
    managed_paths: [priorManaged],
  });

  assert.deepEqual(hostConfig.agents.list[0].memorySearch.extraPaths, [
    originalUnrelated,
    priorManaged,
    newUnrelated,
  ]);
  assert.deepEqual(indexed, ["main"]);
  assert.deepEqual(
    JSON.parse(await readFile(join(config.runtime_storage, "retrieval-paths.json"), "utf8")),
    {
      schema_version: "cognitive-runtime.retrieval-path-ownership/v1",
      instance_id: config.instance_id,
      agent_id: "main",
      paths: [priorManaged],
    },
  );
});

test("OpenClaw command adapter uses supported forced index, deep status, search, and tools.invoke get", async () => {
  const calls = [];
  const commands = new OpenClawCliRetrievalCommands(async (arguments_) => {
    calls.push(arguments_);
    if (arguments_[0] === "memory" && arguments_[1] === "status") {
      return JSON.stringify([{ agentId: "main", status: {}, embeddingProbe: { ok: true } }]);
    }
    if (arguments_[0] === "memory" && arguments_[1] === "search") {
      return JSON.stringify({ results: [{ path: "projection.md", snippet: "sentinel" }] });
    }
    if (arguments_[0] === "gateway") {
      return JSON.stringify({
        ok: true,
        toolName: "memory_get",
        output: {
          content: [{
            type: "text",
            text: JSON.stringify({ path: "projection.md", text: "sentinel", from: 1, lines: 1 }),
          }],
        },
      });
    }
    return "";
  });

  await commands.index("main");
  assert.deepEqual(await commands.status("main"), [
    { agentId: "main", status: {}, embeddingProbe: { ok: true } },
  ]);
  assert.deepEqual(await commands.search("main", "sentinel query"), {
    results: [{ path: "projection.md", snippet: "sentinel" }],
  });
  assert.deepEqual(await commands.get("main", "projection.md"), {
    path: "projection.md",
    text: "sentinel",
    from: 1,
    lines: 1,
  });
  assert.deepEqual(calls, [
    ["memory", "index", "--force", "--agent", "main"],
    ["memory", "status", "--deep", "--json", "--agent", "main"],
    ["memory", "search", "--json", "--agent", "main", "--query", "sentinel query", "--max-results", "10"],
    [
      "gateway",
      "call",
      "tools.invoke",
      "--json",
      "--params",
      JSON.stringify({
        name: "memory_get",
        args: { path: "projection.md", from: 1, lines: 10_000 },
        agentId: "main",
      }),
    ],
  ]);
});

test("OpenClaw adapter records target ownership before a process interruption can expose it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-openclaw-interruption-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = runtimeConfig(root);
  await mkdir(config.runtime_storage, { recursive: true });
  const oldManaged = join(root, "old-managed");
  const targetManaged = join(root, "target-managed");
  await writeFile(join(config.runtime_storage, "retrieval-paths.json"), JSON.stringify({
    schema_version: "cognitive-runtime.retrieval-path-ownership/v1",
    instance_id: config.instance_id,
    agent_id: "main",
    paths: [oldManaged],
  }));
  const hostConfig = {
    agents: { list: [{ id: "main", memorySearch: { extraPaths: [oldManaged] } }] },
  };
  let interrupt = true;
  const adapter = new OpenClawGenerationConsumptionAdapter(config, {
    config: {
      current: () => hostConfig,
      async mutateConfigFile({ mutate }) {
        await mutate(hostConfig);
        if (interrupt) {
          interrupt = false;
          throw new Error("PROCESS_INTERRUPTED_AFTER_CONFIG_WRITE");
        }
        return { result: undefined };
      },
    },
  }, {
    async index() {},
    async status() { throw new Error("UNEXPECTED_STATUS"); },
    async search() { throw new Error("UNEXPECTED_SEARCH"); },
    async get() { throw new Error("UNEXPECTED_GET"); },
  });
  const snapshot = await adapter.capture();

  await assert.rejects(
    adapter.applyTarget(syncTarget(config, targetManaged)),
    /PROCESS_INTERRUPTED_AFTER_CONFIG_WRITE/,
  );
  assert.deepEqual(hostConfig.agents.list[0].memorySearch.extraPaths, [targetManaged]);
  assert.deepEqual(
    JSON.parse(await readFile(join(config.runtime_storage, "retrieval-paths.json"), "utf8")).paths,
    [targetManaged],
  );

  await adapter.restore(snapshot);
  assert.deepEqual(hostConfig.agents.list[0].memorySearch.extraPaths, [oldManaged]);
});
