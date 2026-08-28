import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  commitSyntheticAuthority,
  writeSyntheticAuthority,
} from "../../../helpers/synthetic-authority.mjs";

const runtime = await import(
  pathToFileURL(new URL("../../../../dist/index.js", import.meta.url).pathname).href
);
async function markdownFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") ? [path] : [];
  }));
  return nested.flat();
}

async function recallPublicCorpus(root, query) {
  for (const path of await markdownFiles(root)) {
    const content = await readFile(path, "utf8");
    if (content.includes(query)) return content;
  }
  throw new Error("PUBLIC_CORPUS_SENTINEL_MISSING");
}

test("public CangHai pack executes the declared cutover behavior", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-canghai-public-pack-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = JSON.parse(await readFile(new URL("./plan.json", import.meta.url), "utf8"));
  assert.equal(template.instance_id, "instance-canghai-deidentified");
  const authorityDirectory = join(root, "authority");
  await writeSyntheticAuthority(authorityDirectory);
  const sourceRevision = await commitSyntheticAuthority(authorityDirectory);
  const legacyPath = join(root, "legacy-private-rag");
  const publicCorpusPath = join(root, "public-author-corpus");
  const workspacePath = join(root, "workspace");
  await Promise.all([
    mkdir(legacyPath, { recursive: true }),
    mkdir(publicCorpusPath, { recursive: true }),
    mkdir(workspacePath, { recursive: true }),
  ]);
  await writeFile(join(publicCorpusPath, "public.md"), "Public corpus remains available.\n");
  const publicCorpusContent = await recallPublicCorpus(publicCorpusPath, "remains available");
  const publicCorpusRecallChecksum = runtime.calculatePublicationContentChecksum(
    publicCorpusContent,
  );
  const planPayload = {
    ...template,
    target_source_revision: sourceRevision,
    remove_retrieval_paths: [legacyPath],
    preserve_independent_paths: [publicCorpusPath],
  };
  delete planPayload.checksum;
  const plan = {
    ...planPayload,
    checksum: runtime.calculateInstanceCutoverPlanChecksum(planPayload),
  };
  const config = {
    schema_version: "cognitive-runtime.instance-runtime-config/v2",
    instance_id: template.instance_id,
    mode: "enforce",
    runtime_storage: join(root, "runtime"),
    generation_storage: join(root, "generation-state", "generations"),
    host: { agent_id: "main", eligible_scope: ["private_main_session"] },
    authority_owner: { provider: "telegram", actor_id: "owner-public-pack" },
    limits: { max_active_runs: 4, drain_timeout_ms: 30_000 },
    adapters: { authority_checkout: authorityDirectory, host_retrieval: "openclaw-memory" },
  };
  const state = runtime.createStateManagementPort({
    stateRoot: config.runtime_storage,
    instanceId: config.instance_id,
  });
  await state.initialize();
  state.close();

  const events = [];
  let bootstrapGeneration;
  const hostConfig = {
    agents: { list: [{
      id: "main",
      memorySearch: { extraPaths: [legacyPath, publicCorpusPath] },
    }] },
    plugins: { entries: { "active-memory": { enabled: true } } },
  };
  let lastSearch;
  const commands = {
    async index() { events.push("host-index"); },
    async status() {
      const projection = hostConfig.agents.list[0].memorySearch.extraPaths.at(-1);
      const files = await markdownFiles(projection);
      return [{
        agentId: "main",
        status: {
          backend: "builtin",
          workspaceDir: projection,
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
    async search(_agentId, query) {
      const projection = hostConfig.agents.list[0].memorySearch.extraPaths.at(-1);
      for (const path of await markdownFiles(projection)) {
        const text = await readFile(path, "utf8");
        if (query.split(" ").every((term) => text.includes(term))) {
          lastSearch = { path: relative(projection, path), text };
          return { results: [{
            path: lastSearch.path,
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
    async get(_agentId, path) {
      assert.equal(path, lastSearch.path);
      return {
        path,
        text: lastSearch.text,
        truncated: false,
        from: 1,
        lines: lastSearch.text.split("\n").length,
      };
    },
  };
  const cutover = {
    async capture() {
      events.push("cutover-capture");
      return { activeMemoryEnabled: hostConfig.plugins.entries["active-memory"].enabled };
    },
    async applyTarget(target) {
      events.push("cutover-apply");
      hostConfig.plugins.entries["active-memory"].enabled = false;
      for (const projection of target.bootstrapProjections) {
        await writeFile(
          join(workspacePath, projection.target),
          await readFile(projection.path, "utf8"),
        );
      }
    },
    async verifyTarget(target) {
      events.push("cutover-verify");
      assert.equal(hostConfig.plugins.entries["active-memory"].enabled, false);
      for (const projection of target.bootstrapProjections) {
        const installed = await readFile(join(workspacePath, projection.target), "utf8");
        const match = installed.match(/generation_id: (generation-[a-f0-9]{64})/);
        assert.ok(match);
        bootstrapGeneration ??= match[1];
        assert.equal(match[1], bootstrapGeneration);
      }
    },
    async restore(snapshot) {
      hostConfig.plugins.entries["active-memory"].enabled = snapshot.activeMemoryEnabled;
    },
    async verifyPrior() {},
  };
  const host = new runtime.OpenClawGenerationConsumptionAdapter(
    config,
    {
      config: {
        current: () => hostConfig,
        async mutateConfigFile({ mutate }) {
          events.push("host-config");
          await mutate(hostConfig);
          return { result: undefined };
        },
      },
    },
    commands,
    cutover,
  );
  const result = await runtime.syncGeneration({
    config,
    sourceRevision,
    packageVersion: "0.2.0",
    hostVersion: "2026.7.1-2",
    nodeVersion: process.versions.node,
    host,
    runs: {
      closeAdmission() { events.push("close-admission"); },
      async drain() { events.push("drain"); },
      openAdmission() { events.push("open-admission"); },
    },
    cutover: {
      plan,
      publication: {
        async verifyRemoteBase() { events.push("remote-base"); },
        async verifyPushedRevision() { events.push("pushed-revision"); },
      },
      publicCorpus: {
        async verifyBefore() {
          events.push("public-before");
          assert.equal(
            await recallPublicCorpus(publicCorpusPath, "remains available"),
            publicCorpusContent,
          );
          return {
            adapterId: template.public_corpus_adapter,
            health: "pass",
            recallChecksum: publicCorpusRecallChecksum,
          };
        },
        async indexTarget() { events.push("public-index"); },
        async verifyAfter(input) {
          events.push("public-after");
          const afterContent = await recallPublicCorpus(
            publicCorpusPath,
            "remains available",
          );
          assert.equal(afterContent, publicCorpusContent);
          return {
            publicCorpus: {
              adapterId: template.public_corpus_adapter,
              health: "pass",
              recallChecksum: runtime.calculatePublicationContentChecksum(afterContent),
            },
            legacyPrivateHits: 0,
            privateRetrievalGenerations: [input.target.syncGeneration],
          };
        },
      },
    },
  });

  const extraPaths = hostConfig.agents.list[0].memorySearch.extraPaths;
  assert.equal(extraPaths.includes(legacyPath), false);
  assert.equal(extraPaths.includes(publicCorpusPath), true);
  assert.equal(extraPaths.at(-1).includes(result.syncGeneration), true);
  assert.equal(bootstrapGeneration, result.syncGeneration);
  assert.equal(hostConfig.plugins.entries["active-memory"].enabled, false);
  assert.deepEqual(events, [
    "remote-base",
    "pushed-revision",
    "public-before",
    "cutover-capture",
    "close-admission",
    "drain",
    "host-config",
    "cutover-apply",
    "host-index",
    "public-index",
    "cutover-verify",
    "public-after",
    "open-admission",
  ]);

  const receiptPath = process.env.STELLA_RUNTIME_PUBLIC_PACK_RECEIPT;
  if (receiptPath !== undefined) {
    await writeFile(receiptPath, JSON.stringify({
      status: "pass",
      planId: plan.plan_id,
      pushBeforeSync: events.indexOf("pushed-revision") < events.indexOf("host-config"),
      legacyRemoval: !extraPaths.includes(legacyPath),
      activeMemoryDisabled: !hostConfig.plugins.entries["active-memory"].enabled,
      bootstrapTargets: plan.bootstrap_targets,
      publicCorpusAdapter: template.public_corpus_adapter,
    }));
  }
});
