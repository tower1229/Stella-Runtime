import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildGeneration,
  calculateInstanceCutoverPlanChecksum,
  calculateRuntimeConfigIdentityChecksum,
  closeMaintenanceGate,
  createStateManagementPort,
  loadMaintenanceGate,
  recoverInterruptedSync,
  syncGeneration,
  ProjectionDeterminismLedger,
  runProjectionProducerConformance,
} from "../../dist/index.js";
import {
  commitAuthorityChanges,
  commitSyntheticAuthority,
  writeSyntheticAuthority,
} from "../helpers/synthetic-authority.mjs";

const checksum = (character) => `sha256:${character.repeat(64)}`;

const fitnessDomain = (
  revision,
  content = "# Fitness history\n\nSynthetic session.\n",
  { sourceReferences = [], retractions = [] } = {},
) => {
  const publication = runProjectionProducerConformance({
    instanceId: "instance-synthetic",
    producerId: "stella-fitness",
    consumerId: "stella-runtime",
    canonicalSourceSnapshot: { revision, sourceAsOf: "2026-08-24T00:00:00Z" },
    determinismLedger: new ProjectionDeterminismLedger(),
    categories: ["fitness_history"],
    sourceReferences,
    conflicts: [],
    retractions,
    capabilities: [{ id: "fitness_history_context", state: "available" }],
    payloads: [{ path: "payloads/history.md", mediaType: "text/markdown", value: content }],
    generatedAt: "2026-08-24T00:01:00Z",
  });
  return {
    domainId: "fitness",
    projection: {
      status: "active",
      projectionRevision: publication.projectionRevision,
      pointerRevision: `pointer-${createHash("sha256").update(revision).digest("hex")}`,
      manifestChecksum: publication.manifestChecksum,
      sourceRevision: publication.manifest.source.revision,
      asOf: publication.manifest.source.as_of,
      manifest: publication.manifest,
      payloads: publication.payloads,
    },
  };
};

const canghaiCutoverPlan = (sourceRevision) => {
  const plan = {
    schema_version: "cognitive-runtime.instance-cutover-plan/v2",
    plan_id: "cutover-canghai-public",
    instance_id: "instance-synthetic",
    target_source_revision: sourceRevision,
    publication_prerequisites: {
      remote_base_check: true,
      push_before_sync: true,
    },
    remove_retrieval_paths: ["/srv/canghai/private/30_RAG"],
    disable_mechanisms: ["active-memory"],
    preserve_independent_paths: ["/srv/canghai/public-author-corpus"],
    bootstrap_targets: ["USER.md", "MEMORY.md"],
    public_corpus_adapter: "canghai-public-corpus",
  };
  return { ...plan, checksum: calculateInstanceCutoverPlanChecksum(plan) };
};

const runtimeConfig = (root) => ({
  schema_version: "cognitive-runtime.instance-runtime-config/v2",
  instance_id: "instance-synthetic",
  mode: "enforce",
  runtime_storage: join(root, "runtime"),
  generation_storage: join(root, "generation-state", "immutable-generations"),
  host: { agent_id: "main", eligible_scope: ["private_main_session"] },
  authority_owner: { provider: "telegram", actor_id: "owner-synthetic" },
  limits: { max_active_runs: 4, drain_timeout_ms: 30_000 },
  adapters: {
    authority_checkout: join(root, "authority"),
    host_retrieval: "openclaw-memory",
  },
});

const runPort = (events) => ({
  closeAdmission() { events.push("close-admission"); },
  openAdmission() { events.push("open-admission"); },
  async drain(timeoutMs) { events.push(`drain:${timeoutMs}`); },
});

const installPriorActivation = async (config, sourceRevision) => {
  const stateDirectory = join(config.generation_storage, "..");
  const built = await buildGeneration({
    authorityDirectory: config.adapters.authority_checkout,
    stateDirectory,
    generationsDirectory: config.generation_storage,
    sourceRevision,
    packageVersion: "0.2.0-test",
  });
  const state = createStateManagementPort({
    stateRoot: config.runtime_storage,
    instanceId: config.instance_id,
  });
  await state.initialize();
  state.close();
  const manifestBytes = await readFile(join(built.generationDirectory, "manifest.json"));
  const manifestChecksum = `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`;
  const projectionChecksum = built.manifest.files.find(
    (file) => file.path === "projection-entries.json",
  ).checksum;
  const receipt = {
    schema_version: "cognitive-runtime.activation-receipt/v2",
    receipt_id: "activation-prior",
    instance_id: config.instance_id,
    generation_id: built.syncGeneration,
    source_revision: sourceRevision,
    manifest_checksum: manifestChecksum,
    projection_checksum: projectionChecksum,
    host_config_checksum: calculateRuntimeConfigIdentityChecksum(config),
    index_evidence: {
      deep_status: "pass",
      search_sentinel_checksum: checksum("7"),
      get_sentinel_checksum: checksum("8"),
    },
    release_channel: "extended-stable",
    openclaw_version: "2026.6.34",
    node_version: process.versions.node,
    verified_at: "2026-08-17T00:00:00.000Z",
  };
  await mkdir(join(config.runtime_storage, "activation-receipts"), { recursive: true });
  await writeFile(
    join(config.runtime_storage, "activation-receipts", "activation-prior.json"),
    JSON.stringify(receipt),
  );
  const pointer = {
    schema_version: "cognitive-runtime.active-generation-pointer/v2",
    instance_id: config.instance_id,
    generation_id: built.syncGeneration,
    source_revision: sourceRevision,
    manifest_checksum: manifestChecksum,
    activation_receipt_id: "activation-prior",
    activated_at: "2026-08-17T00:00:00.000Z",
  };
  await writeFile(
    join(config.runtime_storage, "active-generation.json"),
    `${JSON.stringify(pointer)}\n`,
  );
  return { built, pointer };
};

test("sync rejects an unsmoked Host before Host config, Receipt, or Pointer mutation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-sync-incompatible-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = runtimeConfig(root);
  await writeSyntheticAuthority(config.adapters.authority_checkout);
  const sourceRevision = await commitSyntheticAuthority(config.adapters.authority_checkout);
  const events = [];

  await assert.rejects(syncGeneration({
    config,
    sourceRevision,
    packageVersion: "0.2.0-test",
    hostVersion: "2026.6.34",
    nodeVersion: "24.17.0",
    host: {
      async capture() { events.push("capture"); return {}; },
      async applyTarget() { events.push("apply"); },
      async verifyTarget() { throw new Error("UNEXPECTED_VERIFY"); },
      async restore() { events.push("restore"); },
      async verifyPrior() { throw new Error("UNEXPECTED_PRIOR_VERIFY"); },
    },
    runs: runPort(events),
  }), { message: "INCOMPATIBLE_HOST" });

  assert.deepEqual(events, []);
  await assert.rejects(stat(join(config.runtime_storage, "active-generation.json")), {
    code: "ENOENT",
  });
  await assert.rejects(stat(join(config.runtime_storage, "activation-receipts")), {
    code: "ENOENT",
  });
});

test("sync builds a missing committed target and exposes its Pointer only after Host proof", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-sync-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = runtimeConfig(root);
  await writeSyntheticAuthority(config.adapters.authority_checkout);
  const sourceRevision = await commitSyntheticAuthority(config.adapters.authority_checkout);
  const events = [];
  const host = {
    async capture() {
      events.push("capture");
      return { config_revision: "prior" };
    },
    async applyTarget(target) {
      events.push(`apply:${target.sourceRevision}`);
    },
    async verifyTarget(target) {
      events.push(`verify:${target.sourceRevision}`);
      return {
        deepStatus: "pass",
        generationId: target.syncGeneration,
        sourceRevision: target.sourceRevision,
        projectionChecksum: target.projectionChecksum,
        hostConfigChecksum: target.hostConfigChecksum,
        searchSentinelChecksum: checksum("3"),
        getSentinelChecksum: checksum("4"),
      };
    },
    async restore() {
      events.push("restore");
    },
    async verifyPrior() {
      events.push("verify-prior");
      throw new Error("UNEXPECTED_PRIOR_VERIFY");
    },
  };

  const result = await syncGeneration({
    config,
    sourceRevision,
    packageVersion: "0.2.0-test",
    hostVersion: "2026.6.34",
    nodeVersion: process.versions.node,
    host,
    runs: runPort(events),
  });

  assert.equal(result.sourceRevision, sourceRevision);
  assert.equal(result.reusedGeneration, false);
  assert.deepEqual(events, [
    "capture",
    "close-admission",
    "drain:30000",
    `apply:${sourceRevision}`,
    `verify:${sourceRevision}`,
    "open-admission",
  ]);
  assert.equal(await loadMaintenanceGate(config.runtime_storage), null);

  const receipt = JSON.parse(await readFile(result.receiptPath, "utf8"));
  const pointer = JSON.parse(await readFile(
    join(config.runtime_storage, "active-generation.json"),
    "utf8",
  ));
  assert.equal(receipt.generation_id, result.syncGeneration);
  assert.equal(receipt.source_revision, sourceRevision);
  assert.equal(receipt.release_channel, "extended-stable");
  assert.equal(pointer.generation_id, result.syncGeneration);
  assert.equal(pointer.activation_receipt_id, receipt.receipt_id);
});

test("sync v3 repeats the exact Authority/domain tuple in Receipt and final Pointer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-sync-v3-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = runtimeConfig(root);
  await writeSyntheticAuthority(config.adapters.authority_checkout);
  const sourceRevision = await commitSyntheticAuthority(config.adapters.authority_checkout);
  const domain = fitnessDomain("fitness-f1");
  const events = [];
  const host = {
    async capture() { events.push("capture"); return { config_revision: "prior" }; },
    async applyTarget() { events.push("apply"); },
    async verifyTarget(target) {
      events.push("verify");
      assert.equal(target.domainIndexes[0].desired_count, 1);
      const previousRevision = target.previousDomainIndexes[0]?.projection_revision ?? null;
      return {
        deepStatus: "pass",
        generationId: target.syncGeneration,
        sourceRevision: target.sourceRevision,
        projectionChecksum: target.projectionChecksum,
        hostConfigChecksum: target.hostConfigChecksum,
        searchSentinelChecksum: checksum("3"),
        getSentinelChecksum: checksum("4"),
        domains: [{
          domainId: "fitness",
          projectionRevision: domain.projection.projectionRevision,
          manifestChecksum: domain.projection.manifestChecksum,
          desiredCount: 1,
          indexedCount: 1,
          previousRevision,
          previousStableIdHits: 0,
          previousTextSentinelHits: 0,
          previousSourceReferenceHits: 0,
        }],
      };
    },
    async restore() { events.push("restore"); },
    async verifyPrior() { throw new Error("UNEXPECTED_PRIOR_VERIFY"); },
  };
  const runs = runPort(events);
  const syncOptions = {
    config,
    sourceRevision,
    packageVersion: "0.2.1-test",
    hostVersion: "2026.6.34",
    nodeVersion: process.versions.node,
    domainProjections: [domain],
    domainProjectionReader: {
      async read() {
        return {
          domain_id: "fitness",
          status: domain.projection.status,
          projection_revision: domain.projection.projectionRevision,
          pointer_revision: domain.projection.pointerRevision,
          manifest_checksum: domain.projection.manifestChecksum,
          source_revision: domain.projection.sourceRevision,
          as_of: domain.projection.asOf,
        };
      },
    },
    host,
    runs,
  };
  const result = await syncGeneration(syncOptions);
  const receipt = JSON.parse(await readFile(result.receiptPath, "utf8"));
  const pointer = JSON.parse(await readFile(result.pointerPath, "utf8"));
  const manifest = JSON.parse(await readFile(join(
    config.generation_storage,
    result.syncGeneration,
    "manifest.json",
  ), "utf8"));

  assert.equal(receipt.schema_version, "cognitive-runtime.activation-receipt/v3");
  assert.equal(pointer.schema_version, "cognitive-runtime.active-generation-pointer/v3");
  assert.deepEqual(receipt.authority, manifest.authority);
  assert.deepEqual(pointer.authority, manifest.authority);
  assert.deepEqual(receipt.domains, manifest.domains);
  assert.deepEqual(receipt.index_evidence.fitness, {
    projection_revision: domain.projection.projectionRevision,
    manifest_checksum: domain.projection.manifestChecksum,
    desired_count: 1,
    indexed_count: 1,
    previous_revision: null,
    previous_stable_id_hits: 0,
    previous_text_sentinel_hits: 0,
    previous_source_reference_hits: 0,
  });
  assert.deepEqual(pointer.domains, manifest.domains);
  assert.equal(pointer.activation_receipt_id, receipt.receipt_id);
  assert.deepEqual(events, [
    "capture",
    "close-admission",
    "drain:30000",
    "apply",
    "verify",
    "open-admission",
  ]);

  await closeMaintenanceGate(config.runtime_storage, sourceRevision);
  const repaired = await syncGeneration(syncOptions);
  assert.equal(repaired.reusedGeneration, true);
  assert.equal(await loadMaintenanceGate(config.runtime_storage), null);
});

test("a failed destructive Fitness replacement stays gated instead of restoring leaking prior content", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-sync-destructive-domain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = runtimeConfig(root);
  await writeSyntheticAuthority(config.adapters.authority_checkout);
  const sourceRevision = await commitSyntheticAuthority(config.adapters.authority_checkout);
  const priorSource = {
    id: "fitness-injury-claim",
    path: "fitness/history/injury.md",
    revision: "fitness-prior",
    checksum: checksum("a"),
  };
  const priorDomain = fitnessDomain(
    "fitness-prior",
    "# Fitness history\n\nOld injury claim.\n",
    { sourceReferences: [priorSource] },
  );
  const evidenceFor = (target) => ({
    deepStatus: "pass",
    generationId: target.syncGeneration,
    sourceRevision: target.sourceRevision,
    projectionChecksum: target.projectionChecksum,
    hostConfigChecksum: target.hostConfigChecksum,
    searchSentinelChecksum: checksum("3"),
    getSentinelChecksum: checksum("4"),
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
  });
  const prior = await syncGeneration({
    config,
    sourceRevision,
    packageVersion: "0.2.1-test",
    hostVersion: "2026.6.34",
    nodeVersion: process.versions.node,
    domainProjections: [priorDomain],
    host: {
      async capture() { return { config_revision: "empty" }; },
      async applyTarget() {},
      async verifyTarget(target) { return evidenceFor(target); },
      async restore() {},
      async verifyPrior() { throw new Error("UNEXPECTED_PRIOR_VERIFY"); },
    },
    runs: { closeAdmission() {}, openAdmission() {}, async drain() {} },
  });
  const priorPointer = JSON.parse(await readFile(prior.pointerPath, "utf8"));
  const correctedDomain = fitnessDomain(
    "fitness-corrected",
    "# Fitness history\n\nCorrected: no injury claim.\n",
    {
      sourceReferences: [{
        ...priorSource,
        revision: "fitness-corrected",
        checksum: checksum("b"),
      }],
      retractions: [{
        id: "retract-injury-claim",
        source_reference_id: priorSource.id,
        retracted_revision: priorDomain.projection.projectionRevision,
      }],
    },
  );
  const events = [];

  await assert.rejects(syncGeneration({
    config,
    sourceRevision,
    packageVersion: "0.2.1-test",
    hostVersion: "2026.6.34",
    nodeVersion: process.versions.node,
    domainProjections: [correctedDomain],
    host: {
      async capture() { events.push("capture"); return { config_revision: "prior" }; },
      async applyTarget() { events.push("apply"); throw new Error("INDEX_FAILED"); },
      async verifyTarget() { throw new Error("UNEXPECTED_VERIFY"); },
      async restore() { events.push("restore"); },
      async verifyPrior() { events.push("verify-prior"); throw new Error("UNEXPECTED_PRIOR"); },
    },
    runs: {
      closeAdmission() { events.push("close"); },
      openAdmission() { events.push("open"); },
      async drain() { events.push("drain"); },
    },
  }), /SYNC_DESTRUCTIVE_DOMAIN_RECOVERY_BLOCKED/);

  assert.deepEqual(events, ["capture", "close", "drain", "apply"]);
  assert.notEqual(await loadMaintenanceGate(config.runtime_storage), null);
  assert.deepEqual(
    JSON.parse(await readFile(prior.pointerPath, "utf8")),
    priorPointer,
  );
  const journal = JSON.parse(await readFile(
    join(config.runtime_storage, "sync-journal.json"),
    "utf8",
  ));
  assert.equal(journal.phase, "recovery_failed");
  assert.equal(journal.prior_restore_forbidden, true);

  const resumed = await syncGeneration({
    config,
    sourceRevision,
    packageVersion: "0.2.1-test",
    hostVersion: "2026.6.34",
    nodeVersion: process.versions.node,
    domainProjections: [correctedDomain],
    host: {
      async capture() { throw new Error("MUST_REUSE_DURABLE_PRIOR_SNAPSHOT"); },
      async applyTarget() { events.push("resume-apply"); },
      async verifyTarget(target) { return evidenceFor(target); },
      async restore() { throw new Error("UNEXPECTED_RESTORE"); },
      async verifyPrior() { throw new Error("UNEXPECTED_PRIOR_VERIFY"); },
    },
    runs: { closeAdmission() {}, openAdmission() {}, async drain() {} },
  });
  const resumedPointer = JSON.parse(await readFile(resumed.pointerPath, "utf8"));
  assert.equal(
    resumedPointer.domains[0].projection_revision,
    correctedDomain.projection.projectionRevision,
  );
  assert.equal(await loadMaintenanceGate(config.runtime_storage), null);
});

test("sync enforces the CangHai cutover contract before and inside one Activation Barrier", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-sync-cutover-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = runtimeConfig(root);
  await writeSyntheticAuthority(config.adapters.authority_checkout);
  const sourceRevision = await commitSyntheticAuthority(config.adapters.authority_checkout);
  const plan = canghaiCutoverPlan(sourceRevision);
  const events = [];
  let cutoverTarget;
  const host = {
    async capture(target) {
      events.push("capture");
      cutoverTarget = target.cutover;
      return { config_revision: "prior", cutover_state: { active_memory: true } };
    },
    async applyTarget(target) {
      events.push("apply-cutover");
      assert.equal(target.cutover.plan.checksum, plan.checksum);
      assert.deepEqual(
        target.cutover.bootstrapProjections.map((projection) => projection.target),
        ["MEMORY.md", "USER.md"],
      );
      for (const projection of target.cutover.bootstrapProjections) {
        const content = await readFile(projection.path, "utf8");
        assert.match(content, new RegExp(`generation_id: ${target.syncGeneration}`));
        assert.match(content, /bootstrap_alias:/);
        assert.match(content, /read_only: true/);
        assert.equal((await stat(projection.path)).mode & 0o222, 0);
      }
    },
    async verifyTarget(target) {
      events.push("verify-host");
      return {
        deepStatus: "pass",
        generationId: target.syncGeneration,
        sourceRevision: target.sourceRevision,
        projectionChecksum: target.projectionChecksum,
        hostConfigChecksum: target.hostConfigChecksum,
        searchSentinelChecksum: checksum("3"),
        getSentinelChecksum: checksum("4"),
      };
    },
    async restore() { throw new Error("UNEXPECTED_RESTORE"); },
    async verifyPrior() { throw new Error("UNEXPECTED_PRIOR_VERIFY"); },
  };

  const result = await syncGeneration({
    config,
    sourceRevision,
    packageVersion: "0.2.0-test",
    hostVersion: "2026.6.34",
    nodeVersion: process.versions.node,
    host,
    runs: runPort(events),
    cutover: {
      plan,
      publication: {
        async verifyRemoteBase(input) {
          events.push("remote-base");
          assert.equal(input.sourceRevision, sourceRevision);
        },
        async verifyPushedRevision(input) {
          events.push("pushed-revision");
          assert.equal(input.sourceRevision, sourceRevision);
        },
      },
      publicCorpus: {
        async verifyBefore(input) {
          events.push("public-corpus-before");
          assert.equal(input.plan.public_corpus_adapter, "canghai-public-corpus");
          return {
            adapterId: "canghai-public-corpus",
            health: "pass",
            recallChecksum: checksum("5"),
          };
        },
        async verifyAfter(input) {
          events.push("public-corpus-after");
          assert.equal(input.target.syncGeneration, cutoverTarget.bootstrapProjections[0]
            .path.split("/").at(-2));
          return {
            publicCorpus: {
              adapterId: "canghai-public-corpus",
              health: "pass",
              recallChecksum: checksum("6"),
            },
            legacyPrivateHits: 0,
            privateRetrievalGenerations: [input.target.syncGeneration],
          };
        },
        async indexTarget(input) {
          events.push("public-corpus-index");
          assert.equal(input.target.sourceRevision, sourceRevision);
        },
      },
    },
  });

  assert.deepEqual(events, [
    "remote-base",
    "pushed-revision",
    "public-corpus-before",
    "capture",
    "close-admission",
    "drain:30000",
    "apply-cutover",
    "public-corpus-index",
    "verify-host",
    "public-corpus-after",
    "open-admission",
  ]);
  assert.equal(
    JSON.parse(await readFile(result.receiptPath, "utf8")).cutover_plan_checksum,
    plan.checksum,
  );
});

test("sync rejects a tampered cutover plan before touching publication or Host state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-sync-cutover-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = runtimeConfig(root);
  await writeSyntheticAuthority(config.adapters.authority_checkout);
  const sourceRevision = await commitSyntheticAuthority(config.adapters.authority_checkout);
  const plan = { ...canghaiCutoverPlan(sourceRevision), checksum: checksum("0") };
  let touched = false;

  await assert.rejects(syncGeneration({
    config,
    sourceRevision,
    packageVersion: "0.2.0-test",
    hostVersion: "2026.6.34",
    nodeVersion: process.versions.node,
    host: {
      async capture() { touched = true; return {}; },
      async applyTarget() {},
      async verifyTarget() { throw new Error("UNEXPECTED_VERIFY"); },
      async restore() {},
      async verifyPrior() { throw new Error("UNEXPECTED_PRIOR_VERIFY"); },
    },
    runs: { closeAdmission() {}, openAdmission() {}, async drain() {} },
    cutover: {
      plan,
      publication: {
        async verifyRemoteBase() { touched = true; },
        async verifyPushedRevision() { touched = true; },
      },
      publicCorpus: {
        async verifyBefore() { touched = true; },
        async indexTarget() { touched = true; },
        async verifyAfter() { touched = true; },
      },
    },
  }), /CUTOVER_PLAN_CHECKSUM_MISMATCH/);
  assert.equal(touched, false);
});

test("sync restores the prior Generation when post-cutover evidence still finds legacy private hits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-sync-cutover-legacy-hit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = runtimeConfig(root);
  await writeSyntheticAuthority(config.adapters.authority_checkout);
  const priorRevision = await commitSyntheticAuthority(config.adapters.authority_checkout);
  const prior = await installPriorActivation(config, priorRevision);
  await writeFile(join(config.adapters.authority_checkout, "metadata.txt"), "target\n");
  const sourceRevision = await commitAuthorityChanges(config.adapters.authority_checkout);
  const plan = canghaiCutoverPlan(sourceRevision);
  const events = [];

  await assert.rejects(syncGeneration({
    config,
    sourceRevision,
    packageVersion: "0.2.0-test",
    hostVersion: "2026.6.34",
    nodeVersion: process.versions.node,
    host: {
      async capture() { return { config_revision: "prior" }; },
      async applyTarget() { events.push("apply"); },
      async verifyTarget(target) {
        events.push("verify-target");
        return {
          deepStatus: "pass",
          generationId: target.syncGeneration,
          sourceRevision: target.sourceRevision,
          projectionChecksum: target.projectionChecksum,
          hostConfigChecksum: target.hostConfigChecksum,
          searchSentinelChecksum: checksum("3"),
          getSentinelChecksum: checksum("4"),
        };
      },
      async restore() { events.push("restore"); },
      async verifyPrior(_snapshot, target) {
        events.push("verify-prior");
        return {
          deepStatus: "pass",
          generationId: target.syncGeneration,
          sourceRevision: target.sourceRevision,
          projectionChecksum: target.projectionChecksum,
          hostConfigChecksum: target.hostConfigChecksum,
          searchSentinelChecksum: checksum("7"),
          getSentinelChecksum: checksum("8"),
        };
      },
    },
    runs: runPort(events),
    cutover: {
      plan,
      publication: {
        async verifyRemoteBase() {},
        async verifyPushedRevision() {},
      },
      publicCorpus: {
        async verifyBefore() {
          return {
            adapterId: "canghai-public-corpus",
            health: "pass",
            recallChecksum: checksum("5"),
          };
        },
        async verifyAfter(input) {
          return {
            publicCorpus: {
              adapterId: "canghai-public-corpus",
              health: "pass",
              recallChecksum: checksum("6"),
            },
            legacyPrivateHits: 1,
            privateRetrievalGenerations: [input.target.syncGeneration],
          };
        },
        async indexTarget() { events.push("public-corpus-index"); },
      },
    },
  }), /CUTOVER_LEGACY_PRIVATE_HITS_PRESENT/);

  assert.deepEqual(events, [
    "close-admission",
    "drain:30000",
    "apply",
    "public-corpus-index",
    "verify-target",
    "restore",
    "verify-prior",
    "open-admission",
  ]);
  assert.deepEqual(
    JSON.parse(await readFile(join(config.runtime_storage, "active-generation.json"), "utf8")),
    prior.pointer,
  );
});

test("sync restores verified prior Host state and preserves the old Pointer on failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-sync-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = runtimeConfig(root);
  await writeSyntheticAuthority(config.adapters.authority_checkout);
  const priorRevision = await commitSyntheticAuthority(config.adapters.authority_checkout);
  const prior = await installPriorActivation(config, priorRevision);
  await writeFile(join(config.adapters.authority_checkout, "metadata.txt"), "target\n");
  const sourceRevision = await commitAuthorityChanges(config.adapters.authority_checkout);
  const pointerPath = join(config.runtime_storage, "active-generation.json");
  const events = [];

  await assert.rejects(syncGeneration({
    config,
    sourceRevision,
    packageVersion: "0.2.0-test",
    hostVersion: "2026.6.34",
    nodeVersion: process.versions.node,
    host: {
      async capture() { return { config_revision: "prior" }; },
      async applyTarget() { events.push("apply"); },
      async verifyTarget() {
        events.push("verify-target");
        throw new Error("HOST_SENTINEL_FAILED");
      },
      async restore(snapshot) { events.push(`restore:${snapshot.config_revision}`); },
      async verifyPrior(snapshot, target) {
        events.push("verify-prior");
        return {
          deepStatus: "pass",
          generationId: target.syncGeneration,
          sourceRevision: target.sourceRevision,
          projectionChecksum: target.projectionChecksum,
          hostConfigChecksum: target.hostConfigChecksum,
          searchSentinelChecksum: checksum("7"),
          getSentinelChecksum: checksum("8"),
        };
      },
    },
    runs: {
      closeAdmission() { events.push("close-admission"); },
      openAdmission() { events.push("open-admission"); },
      async drain() { events.push("drain"); },
    },
  }), /HOST_SENTINEL_FAILED/);

  assert.deepEqual(events, [
    "close-admission",
    "drain",
    "apply",
    "verify-target",
    "restore:prior",
    "verify-prior",
    "open-admission",
  ]);
  assert.deepEqual(JSON.parse(await readFile(pointerPath, "utf8")), prior.pointer);
  assert.equal(await loadMaintenanceGate(config.runtime_storage), null);
  const journal = JSON.parse(await readFile(
    join(config.runtime_storage, "sync-journal.json"),
    "utf8",
  ));
  assert.equal(journal.phase, "prior_restored");
});

test("sync keeps the durable Gate closed when neither target nor prior Host state is proven", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-sync-fail-closed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = runtimeConfig(root);
  await writeSyntheticAuthority(config.adapters.authority_checkout);
  const sourceRevision = await commitSyntheticAuthority(config.adapters.authority_checkout);

  await assert.rejects(syncGeneration({
    config,
    sourceRevision,
    packageVersion: "0.2.0-test",
    hostVersion: "2026.6.34",
    nodeVersion: process.versions.node,
    host: {
      async capture() { return { config_revision: "prior" }; },
      async applyTarget() {},
      async verifyTarget() { throw new Error("HOST_SENTINEL_FAILED"); },
      async restore() {},
      async verifyPrior() { throw new Error("MUST_NOT_VERIFY_MISSING_PRIOR"); },
    },
    runs: { closeAdmission() {}, openAdmission() {}, async drain() {} },
  }), /SYNC_RECOVERY_FAILED:SYNC_PRIOR_POINTER_MISSING/);

  assert.equal(
    (await loadMaintenanceGate(config.runtime_storage))?.targetSourceRevision,
    sourceRevision,
  );
  const journal = JSON.parse(await readFile(
    join(config.runtime_storage, "sync-journal.json"),
    "utf8",
  ));
  assert.equal(journal.phase, "recovery_failed");
});

test("prior recovery keeps the Gate closed when search/get sentinel proof drifts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-sync-prior-drift-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = runtimeConfig(root);
  await writeSyntheticAuthority(config.adapters.authority_checkout);
  const priorRevision = await commitSyntheticAuthority(config.adapters.authority_checkout);
  await installPriorActivation(config, priorRevision);
  await writeFile(join(config.adapters.authority_checkout, "metadata.txt"), "target\n");
  const sourceRevision = await commitAuthorityChanges(config.adapters.authority_checkout);

  await assert.rejects(syncGeneration({
    config,
    sourceRevision,
    packageVersion: "0.2.0-test",
    hostVersion: "2026.6.34",
    nodeVersion: process.versions.node,
    host: {
      async capture() { return { config_revision: "prior" }; },
      async applyTarget() {},
      async verifyTarget() { throw new Error("HOST_SENTINEL_FAILED"); },
      async restore() {},
      async verifyPrior(_snapshot, target) {
        return {
          deepStatus: "pass",
          generationId: target.syncGeneration,
          sourceRevision: target.sourceRevision,
          projectionChecksum: target.projectionChecksum,
          hostConfigChecksum: target.hostConfigChecksum,
          searchSentinelChecksum: checksum("9"),
          getSentinelChecksum: checksum("8"),
        };
      },
    },
    runs: { closeAdmission() {}, openAdmission() {}, async drain() {} },
  }), /SYNC_RECOVERY_FAILED:SYNC_HOST_SENTINEL_MISMATCH/);

  assert.notEqual(await loadMaintenanceGate(config.runtime_storage), null);
});

test("startup resolves a prepared Journal and orphan Gate without Host mutation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-sync-prepared-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = runtimeConfig(root);
  await mkdir(config.runtime_storage, { recursive: true });
  await writeFile(join(config.runtime_storage, "sync-journal.json"), JSON.stringify({
    target_source_revision: "b".repeat(40),
    sync_generation: `generation-${"b".repeat(64)}`,
    prior: { config_revision: "prior" },
    prior_pointer: null,
    started_at: "2026-08-17T00:00:00.000Z",
    phase: "prepared",
  }));
  await writeFile(join(config.runtime_storage, "maintenance-gate.json"), JSON.stringify({
    target_source_revision: "b".repeat(40),
    closed_at: "2026-08-17T00:00:00.000Z",
  }));

  await recoverInterruptedSync({
    config,
    hostVersion: "2026.6.34",
    nodeVersion: process.versions.node,
    host: {
      async capture() { throw new Error("UNEXPECTED_CAPTURE"); },
      async applyTarget() { throw new Error("UNEXPECTED_APPLY"); },
      async verifyTarget() { throw new Error("UNEXPECTED_VERIFY"); },
      async restore() { throw new Error("UNEXPECTED_RESTORE"); },
      async verifyPrior() { throw new Error("UNEXPECTED_PRIOR_VERIFY"); },
    },
  });

  const journal = JSON.parse(await readFile(
    join(config.runtime_storage, "sync-journal.json"),
    "utf8",
  ));
  assert.equal(journal.phase, "prior_restored");
  assert.equal(await loadMaintenanceGate(config.runtime_storage), null);

  await writeFile(join(config.runtime_storage, "maintenance-gate.json"), JSON.stringify({
    target_source_revision: "b".repeat(40),
    closed_at: "2026-08-17T00:00:00.000Z",
  }));
  await recoverInterruptedSync({
    config,
    hostVersion: "2026.6.34",
    nodeVersion: process.versions.node,
    host: {
      async capture() { throw new Error("UNEXPECTED_CAPTURE"); },
      async applyTarget() { throw new Error("UNEXPECTED_APPLY"); },
      async verifyTarget() { throw new Error("UNEXPECTED_VERIFY"); },
      async restore() { throw new Error("UNEXPECTED_RESTORE"); },
      async verifyPrior() { throw new Error("UNEXPECTED_PRIOR_VERIFY"); },
    },
  });
  assert.equal(await loadMaintenanceGate(config.runtime_storage), null);
});

test("restart recovery covers every pre-pointer journal phase without exposing a mixed state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-sync-phase-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = runtimeConfig(root);
  await writeSyntheticAuthority(config.adapters.authority_checkout);
  const priorRevision = await commitSyntheticAuthority(config.adapters.authority_checkout);
  const prior = await installPriorActivation(config, priorRevision);
  const restored = [];
  const host = {
    async capture() { throw new Error("UNEXPECTED_CAPTURE"); },
    async applyTarget() { throw new Error("UNEXPECTED_APPLY"); },
    async verifyTarget() { throw new Error("UNEXPECTED_TARGET_VERIFY"); },
    async restore(snapshot) { restored.push(snapshot.phase); },
    async verifyPrior(_snapshot, target) {
      return {
        deepStatus: "pass",
        generationId: target.syncGeneration,
        sourceRevision: target.sourceRevision,
        projectionChecksum: target.projectionChecksum,
        hostConfigChecksum: target.hostConfigChecksum,
        searchSentinelChecksum: checksum("7"),
        getSentinelChecksum: checksum("8"),
      };
    },
  };
  for (const phase of [
    "prepared",
    "gate_closed",
    "runs_drained",
    "host_applying",
    "host_applied",
    "host_verified",
    "receipt_written",
  ]) {
    await writeFile(join(config.runtime_storage, "active-generation.json"), JSON.stringify(
      prior.pointer,
    ));
    await writeFile(join(config.runtime_storage, "maintenance-gate.json"), JSON.stringify({
      target_source_revision: "b".repeat(40),
      closed_at: "2026-08-17T00:00:00.000Z",
    }));
    await writeFile(join(config.runtime_storage, "sync-journal.json"), JSON.stringify({
      target_source_revision: "b".repeat(40),
      sync_generation: `generation-${"b".repeat(64)}`,
      prior: { phase },
      prior_pointer: prior.pointer,
      started_at: "2026-08-17T00:00:00.000Z",
      phase,
      prior_restore_forbidden: false,
      ...(phase === "receipt_written" ? { receipt_id: "activation-target" } : {}),
    }));

    await recoverInterruptedSync({
      config,
      hostVersion: "2026.6.34",
      nodeVersion: process.versions.node,
      host,
    });
    assert.equal(await loadMaintenanceGate(config.runtime_storage), null, phase);
    assert.equal(JSON.parse(await readFile(
      join(config.runtime_storage, "sync-journal.json"),
      "utf8",
    )).phase, "prior_restored", phase);
  }
  assert.deepEqual(restored, [
    "host_applying",
    "host_applied",
    "host_verified",
    "receipt_written",
  ]);
});

test("restart verifies a fully written target Pointer before completing the Journal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-sync-pointer-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = runtimeConfig(root);
  await writeSyntheticAuthority(config.adapters.authority_checkout);
  const sourceRevision = await commitSyntheticAuthority(config.adapters.authority_checkout);
  const active = await installPriorActivation(config, sourceRevision);
  await writeFile(join(config.runtime_storage, "maintenance-gate.json"), JSON.stringify({
    target_source_revision: sourceRevision,
    closed_at: "2026-08-17T00:00:00.000Z",
  }));
  await writeFile(join(config.runtime_storage, "sync-journal.json"), JSON.stringify({
    target_source_revision: sourceRevision,
    sync_generation: active.built.syncGeneration,
    prior: { config_revision: "older" },
    prior_pointer: null,
    started_at: "2026-08-17T00:00:00.000Z",
    phase: "pointer_written",
    receipt_id: "activation-prior",
    prior_restore_forbidden: false,
  }));
  let restored = false;

  await recoverInterruptedSync({
    config,
    hostVersion: "2026.6.34",
    nodeVersion: process.versions.node,
    host: {
      async capture() { throw new Error("UNEXPECTED_CAPTURE"); },
      async applyTarget() { throw new Error("UNEXPECTED_APPLY"); },
      async verifyTarget(target) {
        return {
          deepStatus: "pass",
          generationId: target.syncGeneration,
          sourceRevision: target.sourceRevision,
          projectionChecksum: target.projectionChecksum,
          hostConfigChecksum: target.hostConfigChecksum,
          searchSentinelChecksum: checksum("7"),
          getSentinelChecksum: checksum("8"),
        };
      },
      async restore() { restored = true; },
      async verifyPrior() { throw new Error("UNEXPECTED_PRIOR_VERIFY"); },
    },
  });

  assert.equal(restored, false);
  assert.equal(await loadMaintenanceGate(config.runtime_storage), null);
  assert.equal(JSON.parse(await readFile(
    join(config.runtime_storage, "sync-journal.json"),
    "utf8",
  )).phase, "completed");
});

test("restart recovers an interrupted Journal before beginning another target", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-sync-restart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = runtimeConfig(root);
  await writeSyntheticAuthority(config.adapters.authority_checkout);
  const priorRevision = await commitSyntheticAuthority(config.adapters.authority_checkout);
  const prior = await installPriorActivation(config, priorRevision);
  await writeFile(join(config.adapters.authority_checkout, "metadata.txt"), "target\n");
  const sourceRevision = await commitAuthorityChanges(config.adapters.authority_checkout);
  await writeFile(join(config.runtime_storage, "maintenance-gate.json"), JSON.stringify({
    target_source_revision: "b".repeat(40),
    closed_at: "2026-08-17T00:00:00.000Z",
  }));
  await writeFile(join(config.runtime_storage, "sync-journal.json"), JSON.stringify({
    target_source_revision: "b".repeat(40),
    sync_generation: `generation-${"b".repeat(64)}`,
    prior: { config_revision: "interrupted-prior" },
    prior_pointer: prior.pointer,
    started_at: "2026-08-17T00:00:00.000Z",
    phase: "host_applied",
  }));
  const events = [];
  const lifecycle = [];

  await syncGeneration({
    config,
    sourceRevision,
    packageVersion: "0.2.0-test",
    hostVersion: "2026.6.34",
    nodeVersion: process.versions.node,
    host: {
      async capture() { events.push("capture-new"); return { config_revision: "new-prior" }; },
      async applyTarget() { events.push("apply-new"); },
      async verifyTarget(target) {
        events.push("verify-new");
        return {
          deepStatus: "pass",
          generationId: target.syncGeneration,
          sourceRevision: target.sourceRevision,
          projectionChecksum: target.projectionChecksum,
          hostConfigChecksum: target.hostConfigChecksum,
          searchSentinelChecksum: checksum("3"),
          getSentinelChecksum: checksum("4"),
        };
      },
      async restore(snapshot) { events.push(`restore:${snapshot.config_revision}`); },
      async verifyPrior(snapshot, target) {
        events.push(`verify-prior:${snapshot.config_revision}`);
        return {
          deepStatus: "pass",
          generationId: target.syncGeneration,
          sourceRevision: target.sourceRevision,
          projectionChecksum: target.projectionChecksum,
          hostConfigChecksum: target.hostConfigChecksum,
          searchSentinelChecksum: checksum("7"),
          getSentinelChecksum: checksum("8"),
        };
      },
    },
    runs: {
      closeAdmission() { events.push("close-admission"); },
      openAdmission() { events.push("open-admission"); },
      async drain() { events.push("drain-new"); },
    },
    lifecycle: { recordLifecycle(outcome) { lifecycle.push(outcome); } },
  });

  assert.deepEqual(events.slice(0, 5), [
    "close-admission",
    "restore:interrupted-prior",
    "verify-prior:interrupted-prior",
    "open-admission",
    "capture-new",
  ]);
  assert.deepEqual(lifecycle, [
    "rollback_restored",
    "pending_activation",
    "activated",
  ]);
});

test("concurrent sync calls serialize the durable transaction and Host transition", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-sync-concurrent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = runtimeConfig(root);
  await writeSyntheticAuthority(config.adapters.authority_checkout);
  const sourceRevision = await commitSyntheticAuthority(config.adapters.authority_checkout);
  let releaseFirst;
  const firstPaused = new Promise((resolve) => { releaseFirst = resolve; });
  let applyCount = 0;
  let activeApplies = 0;
  let maxActiveApplies = 0;
  const host = {
    async capture() { return { config_revision: "prior" }; },
    async applyTarget() {
      applyCount += 1;
      activeApplies += 1;
      maxActiveApplies = Math.max(maxActiveApplies, activeApplies);
      if (applyCount === 1) await firstPaused;
      activeApplies -= 1;
    },
    async verifyTarget(target) {
      return {
        deepStatus: "pass",
        generationId: target.syncGeneration,
        sourceRevision: target.sourceRevision,
        projectionChecksum: target.projectionChecksum,
        hostConfigChecksum: target.hostConfigChecksum,
        searchSentinelChecksum: checksum("3"),
        getSentinelChecksum: checksum("4"),
      };
    },
    async restore() {},
    async verifyPrior() { throw new Error("UNEXPECTED_PRIOR_VERIFY"); },
  };
  const options = {
    config,
    sourceRevision,
    packageVersion: "0.2.0-test",
    hostVersion: "2026.6.34",
    nodeVersion: process.versions.node,
    host,
    runs: { closeAdmission() {}, openAdmission() {}, async drain() {} },
  };

  const first = syncGeneration(options);
  while (applyCount === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  const second = syncGeneration(options);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(applyCount, 1);
  releaseFirst();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.syncGeneration, secondResult.syncGeneration);
  assert.equal(applyCount, 2);
  assert.equal(maxActiveApplies, 1);
});
