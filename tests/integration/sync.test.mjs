import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildGeneration,
  calculateRuntimeConfigIdentityChecksum,
  createStateManagementPort,
  loadMaintenanceGate,
  recoverInterruptedSync,
  syncGeneration,
} from "../../dist/index.js";
import {
  commitAuthorityChanges,
  commitSyntheticAuthority,
  writeSyntheticAuthority,
} from "../helpers/synthetic-authority.mjs";

const checksum = (character) => `sha256:${character.repeat(64)}`;

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
  assert.equal(pointer.generation_id, result.syncGeneration);
  assert.equal(pointer.activation_receipt_id, receipt.receipt_id);
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
  });

  assert.deepEqual(events.slice(0, 5), [
    "close-admission",
    "restore:interrupted-prior",
    "verify-prior:interrupted-prior",
    "open-admission",
    "capture-new",
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
