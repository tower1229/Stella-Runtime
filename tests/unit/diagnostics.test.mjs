import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inspectGenerationStatus,
  inspectStoredGenerationStatus,
  RuntimeHealthMonitor,
  validateActiveReceipt,
} from "../../dist/diagnostics/index.js";
import {
  calculateRuntimeConfigIdentityChecksum,
} from "../../dist/runtime/binding.js";

const generation = `generation-${"a".repeat(64)}`;
const manifestChecksum = `sha256:${"1".repeat(64)}`;
const projectionChecksum = `sha256:${"2".repeat(64)}`;
const configChecksum = `sha256:${"3".repeat(64)}`;

const config = (root, mode = "enforce") => ({
  schema_version: "cognitive-runtime.instance-runtime-config/v2",
  instance_id: "instance-synthetic",
  mode,
  runtime_storage: join(root, "runtime"),
  generation_storage: join(root, "generations"),
  host: { agent_id: "main", eligible_scope: ["private_main_session"] },
  authority_owner: { provider: "telegram", actor_id: "owner-synthetic" },
  limits: { max_active_runs: 4, drain_timeout_ms: 30_000 },
  adapters: {
    authority_checkout: join(root, "authority"),
    host_retrieval: "openclaw-memory",
    public_corpus: "public-synthetic",
  },
});

const active = {
  pointer: {
    schema_version: "cognitive-runtime.active-generation-pointer/v2",
    instance_id: "instance-synthetic",
    generation_id: generation,
    source_revision: "a".repeat(40),
    manifest_checksum: manifestChecksum,
    activation_receipt_id: "activation-synthetic",
    activated_at: "2026-08-18T00:00:00.000Z",
  },
  receipt: {
    schema_version: "cognitive-runtime.activation-receipt/v2",
    receipt_id: "activation-synthetic",
    instance_id: "instance-synthetic",
    generation_id: generation,
    source_revision: "a".repeat(40),
    manifest_checksum: manifestChecksum,
    projection_checksum: projectionChecksum,
    host_config_checksum: configChecksum,
    index_evidence: {
      deep_status: "pass",
      search_sentinel_checksum: `sha256:${"4".repeat(64)}`,
      get_sentinel_checksum: `sha256:${"5".repeat(64)}`,
    },
    release_channel: "extended-stable",
    openclaw_version: "2026.6.34",
    node_version: "24.18.0",
    verified_at: "2026-08-18T00:00:00.000Z",
  },
  manifest: {
    schema_version: "cognitive-runtime.generation-manifest/v2",
    generation_id: generation,
    source_revision: "a".repeat(40),
    contract_version: "v2",
    builder_format_version: "1",
    package_version: "0.2.0-test",
    files: [],
    manifest_checksum: manifestChecksum,
  },
};

test("generation status reports active/latest revisions, gap, pending activation, and receipt identity", async () => {
  assert.deepEqual(await inspectGenerationStatus({
    active,
    latestSourceRevision: "b".repeat(40),
    receiptValidity: { valid: true, reasonCodes: [] },
  }), {
    status: "ok",
    activeSourceRevision: "a".repeat(40),
    latestSourceRevision: "b".repeat(40),
    synchronizationGap: true,
    pendingActivation: true,
    generationId: generation,
    activationReceiptId: "activation-synthetic",
    manifestChecksum,
    receiptValid: true,
    reasonCodes: [],
  });
});

test("generation status preserves Pointer identity when its Receipt is missing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-generation-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(config(root).runtime_storage, { recursive: true });
  await writeFile(
    join(config(root).runtime_storage, "active-generation.json"),
    JSON.stringify(active.pointer),
  );

  assert.deepEqual(await inspectStoredGenerationStatus({
    config: config(root),
    latestSourceRevision: "b".repeat(40),
    hostVersion: "2026.6.34",
    nodeVersion: "24.18.0",
  }), {
    status: "degraded",
    activeSourceRevision: "a".repeat(40),
    latestSourceRevision: "b".repeat(40),
    synchronizationGap: true,
    pendingActivation: true,
    generationId: generation,
    activationReceiptId: "activation-synthetic",
    manifestChecksum,
    receiptValid: false,
    reasonCodes: ["STALE_RECEIPT"],
  });
});

test("Active Receipt must bind the release channel of its exact matrix row", async () => {
  const runtimeConfig = config("/synthetic");
  const mismatched = structuredClone(active);
  mismatched.receipt.host_config_checksum =
    calculateRuntimeConfigIdentityChecksum(runtimeConfig);
  mismatched.receipt.release_channel = "unverified-channel";
  mismatched.manifest.sync_generation = generation;
  mismatched.manifest.files = [{
    path: "projection-entries.json",
    checksum: projectionChecksum,
  }];

  assert.deepEqual(await validateActiveReceipt(
    mismatched,
    runtimeConfig,
    "2026.6.34",
    "24.18.0",
  ), {
    valid: false,
    reasonCodes: ["INCOMPATIBLE_HOST"],
  });
});

test("full self-check separates Authority input validation from environment health", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(config(root).runtime_storage, { recursive: true });
  const monitor = new RuntimeHealthMonitor({
    config: config(root),
    hostVersion: "2026.6.34",
    nodeVersion: "24.18.0",
    pluginDiscovered: () => true,
    authority: { validate: async () => ({ sourceRevision: "b".repeat(40) }) },
    configIdentity: { verify: async () => true },
    retrieval: { verify: async () => undefined },
    publicCorpus: { verify: async () => ({ adapterId: "public-synthetic" }) },
    active: { load: async () => active },
  });

  const result = await monitor.selfCheck();
  assert.equal(result.status, "pass");
  assert.deepEqual(result.authorityInput, {
    status: "pass",
    sourceRevision: "b".repeat(40),
    reasonCodes: [],
  });
  assert.deepEqual(result.environment.checks.map((check) => [check.id, check.status]), [
    ["runtime_storage", "pass"],
    ["plugin_discovery", "pass"],
    ["host_capabilities", "pass"],
    ["config_identity", "pass"],
    ["index_retrieval", "pass"],
    ["public_corpus", "pass"],
  ]);
});

test("self-check rejects an engine-compatible Node version absent from the matrix", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-unsmoked-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(config(root).runtime_storage, { recursive: true });
  const monitor = new RuntimeHealthMonitor({
    config: config(root),
    hostVersion: "2026.6.34",
    nodeVersion: "24.17.0",
    pluginDiscovered: () => true,
    hostCapabilities: () => true,
    authority: { validate: async () => ({ sourceRevision: "b".repeat(40) }) },
    configIdentity: { verify: async () => true },
    retrieval: { verify: async () => undefined },
    publicCorpus: { verify: async () => ({ adapterId: "public-synthetic" }) },
    active: { load: async () => active },
  });

  const result = await monitor.selfCheck();
  assert.equal(result.status, "fail");
  assert.deepEqual(
    result.environment.checks.find((check) => check.id === "host_capabilities"),
    {
      id: "host_capabilities",
      status: "fail",
      reasonCodes: ["INCOMPATIBLE_HOST"],
    },
  );
});

test("self-check preserves Receipt Host incompatibility instead of reporting config drift", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-receipt-reason-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(config(root).runtime_storage, { recursive: true });
  const monitor = new RuntimeHealthMonitor({
    config: config(root),
    hostVersion: "2026.6.34",
    nodeVersion: "24.18.0",
    pluginDiscovered: () => true,
    hostCapabilities: () => true,
    authority: { validate: async () => ({ sourceRevision: "a".repeat(40) }) },
    configIdentity: { verify: async () => ({
      valid: false,
      reasonCodes: ["CONFIG_DRIFT", "INCOMPATIBLE_HOST"],
    }) },
    retrieval: { verify: async () => undefined },
    publicCorpus: { verify: async () => ({ adapterId: "public-synthetic" }) },
    active: { load: async () => active },
  });

  const check = await monitor.selfCheck();
  assert.deepEqual(
    check.environment.checks.find((item) => item.id === "config_identity").reasonCodes,
    ["CONFIG_DRIFT", "INCOMPATIBLE_HOST"],
  );
});

test("reconciliation persists stable drift codes and enforce gates while observe records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-drift-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(config(root).runtime_storage, { recursive: true });
  let retrievalHealthy = false;
  const options = {
    config: config(root),
    hostVersion: "2026.6.34",
    nodeVersion: "24.18.0",
    pluginDiscovered: () => true,
    authority: { validate: async () => ({ sourceRevision: "a".repeat(40) }) },
    configIdentity: { verify: async () => true },
    retrieval: { verify: async () => {
      if (!retrievalHealthy) throw new Error("OPENCLAW_INDEX_DIRTY");
    } },
    publicCorpus: { verify: async () => ({ adapterId: "public-synthetic" }) },
    active: { load: async () => active },
  };
  const enforce = new RuntimeHealthMonitor(options);

  const drift = await enforce.reconcile("periodic");
  assert.equal(drift.status, "fail");
  assert.deepEqual(drift.reasonCodes, ["INDEX_DRIFT"]);
  assert.deepEqual(await enforce.checkRunGate(), {
    allowed: false,
    reasonCodes: ["INDEX_DRIFT"],
  });

  const observe = new RuntimeHealthMonitor({ ...options, config: config(root, "observe") });
  assert.deepEqual(await observe.checkRunGate(), {
    allowed: true,
    reasonCodes: ["INDEX_DRIFT"],
  });

  retrievalHealthy = true;
  assert.equal((await enforce.reconcile("detected_drift")).status, "pass");
  assert.deepEqual(await enforce.checkRunGate(), { allowed: true, reasonCodes: [] });
});

test("lifecycle metrics contain bounded outcomes and reject private trace fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-metrics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(config(root).runtime_storage, { recursive: true });
  const monitor = new RuntimeHealthMonitor({
    config: config(root),
    hostVersion: "2026.6.34",
    nodeVersion: "24.18.0",
    pluginDiscovered: () => true,
    authority: { validate: async () => ({ sourceRevision: "a".repeat(40) }) },
    configIdentity: { verify: async () => true },
    retrieval: { verify: async () => undefined },
    active: { load: async () => active },
  });
  for (const outcome of [
    "accepted", "published", "pending_activation", "activated",
    "rollback_restored", "gated",
  ]) monitor.recordLifecycle(outcome);

  assert.deepEqual(monitor.metrics().lifecycle, {
    accepted: 1,
    published: 1,
    pendingActivation: 1,
    activated: 1,
    rollbackRestored: 1,
    gated: 1,
  });
  assert.equal(JSON.stringify(monitor.metrics()).includes("private"), false);
  assert.deepEqual(monitor.lifecycleTraces().map((trace) => trace.outcome), [
    "accepted", "published", "pending_activation", "activated",
    "rollback_restored", "gated",
  ]);
  assert.equal(JSON.stringify(monitor.lifecycleTraces()).includes("private"), false);
});
