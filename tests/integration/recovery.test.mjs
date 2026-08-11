import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createRuntimeRecoveryPort,
  openRuntimeRecoverySnapshot,
  recoverInterruptedRuntimeRestore,
} from "../../dist/recovery/index.js";
import {
  markRuntimeInstanceRunServed,
  SqliteReanswerStore,
} from "../../dist/state/index.js";

const zeroChecksum = `sha256:${"0".repeat(64)}`;
const oneChecksum = `sha256:${"1".repeat(64)}`;
const checksum = (value) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const initialHead = {
  active_seq: 0,
  view_version: "view-synthetic-0",
  checksum: zeroChecksum,
  activated_at: "2026-08-11T00:00:00.000Z",
};

const correction = {
  event: {
    seq: 1,
    event_id: "event-synthetic-1",
    state_id: "state-synthetic-1",
    event_type: "correction",
    payload: { status: "synthetic" },
    observed_at: "2026-08-11T00:00:01.000Z",
    source_kind: "user_explicit",
    idempotency_key: "event-key-synthetic-1",
    created_at: "2026-08-11T00:00:01.000Z",
  },
  newHead: {
    active_seq: 1,
    view_version: "view-synthetic-1",
    checksum: oneChecksum,
    activated_at: "2026-08-11T00:00:01.000Z",
  },
  outbox: {
    correctionId: "correction-synthetic-1",
    instanceId: "instance-synthetic",
    sessionKeyHash: `sha256:${"2".repeat(64)}`,
    priorRunId: "run-synthetic-1",
    idempotencyKey: "outbox-key-synthetic-1",
    createdAt: "2026-08-11T00:00:01.000Z",
  },
};

const createFixture = async (t, name) => {
  const root = await mkdtemp(join(tmpdir(), `stella-recovery-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, "state");
  const instanceDirectory = join(stateRoot, "instance-synthetic");
  const databasePath = join(instanceDirectory, "runtime.sqlite");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(instanceDirectory, { recursive: true });
  const store = new SqliteReanswerStore({ databasePath, initialHead });
  await store.correct(correction);
  store.close();
  const recovery = createRuntimeRecoveryPort({
    stateRoot,
    packageVersion: "0.0.0",
    storageSchemaVersion: "1",
    now: () => "2026-08-11T00:00:05.000Z",
  });
  return { root, stateRoot, databasePath, recovery };
};

const verifyOptions = {
  expectedInstanceId: "instance-synthetic",
  supportedSnapshotSchemaVersions: [
    "cognitive-runtime.runtime-recovery-snapshot-manifest/v1",
  ],
  supportedStorageSchemaVersions: ["1"],
  supportedPackageVersions: ["0.0.0"],
  supportedContractVersions: ["v1"],
  access: "read_only",
};

test("backup exports one immutable authoritative snapshot and verify is read-only", async (t) => {
  const fixture = await createFixture(t, "backup");
  const live = new DatabaseSync(fixture.databasePath);
  live.exec("CREATE TABLE generation_cache(value TEXT); INSERT INTO generation_cache VALUES ('synthetic-derived-only')");
  live.close();
  const outputDirectory = join(fixture.root, "snapshot");
  const snapshot = await fixture.recovery.backup({
    instanceId: "instance-synthetic",
    authorityRevision: "revision-synthetic-1",
    outputDirectory,
    consistency: "transactional_boundary",
  });

  assert.equal(snapshot.directory, outputDirectory);
  assert.equal(snapshot.manifest.state_boundary.active_seq, 1);
  assert.deepEqual(snapshot.manifest.pending_outbox_summary, {
    pending_count: 1,
    in_flight_count: 0,
  });
  assert.deepEqual(snapshot.manifest.projections_requiring_rebuild, [
    "state_view",
    "generation",
    "registry",
    "index",
    "cache",
  ]);
  assert.deepEqual(snapshot.manifest.files.map(({ path }) => path), [
    "authoritative/state.sqlite",
  ]);
  const exported = new DatabaseSync(
    join(outputDirectory, "authoritative/state.sqlite"),
    { readOnly: true },
  );
  assert.equal(
    exported.prepare("SELECT name FROM sqlite_master WHERE name = 'generation_cache'").get(),
    undefined,
  );
  exported.close();

  const before = await readFile(join(outputDirectory, "manifest.json"), "utf8");
  const report = await fixture.recovery.verify(snapshot, verifyOptions);
  const after = await readFile(join(outputDirectory, "manifest.json"), "utf8");
  assert.equal(after, before);
  assert.equal(report.compatibility_result.status, "pass");
  assert.equal(report.integrity_result.status, "pass");
  assert.deepEqual(report.pending_outbox_state, {
    pending_count: 1,
    in_flight_count: 0,
  });
});

test("backup fails closed when authoritative payload contains a credential field", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-recovery-credential-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, "state");
  const instanceDirectory = join(stateRoot, "instance-synthetic");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(instanceDirectory, { recursive: true });
  const store = new SqliteReanswerStore({
    databasePath: join(instanceDirectory, "runtime.sqlite"),
    initialHead,
  });
  const forbiddenField = ["pass", "word"].join("");
  await store.correct({
    ...correction,
    event: {
      ...correction.event,
      payload: { [forbiddenField]: ["synthetic", "placeholder"].join("-") },
    },
  });
  store.close();
  const recovery = createRuntimeRecoveryPort({
    stateRoot,
    packageVersion: "0.0.0",
    storageSchemaVersion: "1",
  });
  const outputDirectory = join(root, "snapshot");

  await assert.rejects(
    recovery.backup({
      instanceId: "instance-synthetic",
      authorityRevision: "revision-synthetic-1",
      outputDirectory,
      consistency: "transactional_boundary",
    }),
    /SNAPSHOT_CREDENTIAL_MATERIAL_FORBIDDEN/,
  );
  await assert.rejects(readFile(join(outputDirectory, "manifest.json")), {
    code: "ENOENT",
  });
});

test("verify deterministically rejects checksum and compatibility damage", async (t) => {
  const fixture = await createFixture(t, "verify-failures");
  const snapshot = await fixture.recovery.backup({
    instanceId: "instance-synthetic",
    authorityRevision: "revision-synthetic-1",
    outputDirectory: join(fixture.root, "snapshot"),
    consistency: "transactional_boundary",
  });
  const artifactPath = join(snapshot.directory, "authoritative/state.sqlite");
  await chmod(artifactPath, 0o600);
  await writeFile(artifactPath, "damaged");

  const damaged = await fixture.recovery.verify(snapshot, verifyOptions);
  assert.equal(damaged.integrity_result.status, "fail");
  assert.ok(damaged.integrity_result.reason_codes.includes("CHECKSUM_MISMATCH"));

  const incompatible = await fixture.recovery.verify(snapshot, {
    ...verifyOptions,
    supportedStorageSchemaVersions: ["2"],
  });
  assert.equal(incompatible.compatibility_result.status, "fail");
  assert.ok(
    incompatible.compatibility_result.reason_codes.includes(
      "STORAGE_SCHEMA_INCOMPATIBLE",
    ),
  );

  const versionCases = [
    ["supportedSnapshotSchemaVersions", ["future-snapshot"], "SNAPSHOT_SCHEMA_INCOMPATIBLE"],
    ["supportedPackageVersions", ["9.9.9"], "PACKAGE_VERSION_INCOMPATIBLE"],
    ["supportedContractVersions", ["v2"], "CONTRACT_VERSION_INCOMPATIBLE"],
  ];
  for (const [field, supportedVersions, reason] of versionCases) {
    const report = await fixture.recovery.verify(snapshot, {
      ...verifyOptions,
      [field]: supportedVersions,
    });
    assert.equal(report.compatibility_result.status, "fail");
    assert.ok(report.compatibility_result.reason_codes.includes(reason));
  }
});

test("restore preserves pending work, is idempotent, and rejects a used target", async (t) => {
  const source = await createFixture(t, "restore-source");
  const snapshot = await source.recovery.backup({
    instanceId: "instance-synthetic",
    authorityRevision: "revision-synthetic-1",
    outputDirectory: join(source.root, "snapshot"),
    consistency: "transactional_boundary",
  });
  const targetRoot = join(source.root, "target-state");
  const target = createRuntimeRecoveryPort({
    stateRoot: targetRoot,
    packageVersion: "0.0.0",
    storageSchemaVersion: "1",
  });
  const options = {
    targetInstanceId: "instance-synthetic",
    restoreIdempotencyKey: "restore-synthetic-1",
    rollback: "required",
    ...verifyOptions,
  };

  const restored = await target.restore(snapshot, options);
  assert.equal(restored.integrity_result.status, "pass");
  assert.deepEqual(restored.restored_active_head, {
    active_seq: 1,
    state_view_version: "view-synthetic-1",
    checksum: oneChecksum,
  });
  assert.equal(restored.authority_revision, "revision-synthetic-1");
  assert.deepEqual(restored.pending_outbox_state, {
    pending_count: 1,
    in_flight_count: 0,
  });

  const repeated = await target.restore(snapshot, options);
  assert.equal(repeated.integrity_result.status, "pass");
  assert.deepEqual(repeated.rollback_result, {
    status: "not_required",
    reason_codes: ["RESTORE_ALREADY_APPLIED"],
  });

  const restoredStore = new SqliteReanswerStore({
    databasePath: join(targetRoot, "instance-synthetic", "runtime.sqlite"),
    initialHead,
  });
  restoredStore.markRunServed("run-synthetic-after-restore");
  restoredStore.close();
  const rejected = await target.restore(snapshot, {
    ...options,
    restoreIdempotencyKey: "restore-synthetic-2",
  });
  assert.equal(rejected.compatibility_result.status, "fail");
  assert.ok(
    rejected.compatibility_result.reason_codes.includes("TARGET_HAS_SERVED_RUN"),
  );

  const mismatched = await target.restore(snapshot, {
    ...options,
    targetInstanceId: "instance-other",
    restoreIdempotencyKey: "restore-synthetic-3",
  });
  assert.equal(mismatched.compatibility_result.status, "fail");
  assert.ok(
    mismatched.compatibility_result.reason_codes.includes("INSTANCE_MISMATCH"),
  );
});

test("restore releases a captured in-flight successor attempt back to pending", async (t) => {
  const source = await createFixture(t, "in-flight-source");
  const store = new SqliteReanswerStore({
    databasePath: source.databasePath,
    initialHead,
  });
  const claim = await store.claim("correction-synthetic-1", {
    successorRunId: "run-synthetic-successor",
    deliveryMode: "command_continuation",
  });
  assert.notEqual(claim, null);
  store.close();
  const snapshot = await source.recovery.backup({
    instanceId: "instance-synthetic",
    authorityRevision: "revision-synthetic-1",
    outputDirectory: join(source.root, "snapshot"),
    consistency: "transactional_boundary",
  });
  assert.deepEqual(snapshot.manifest.pending_outbox_summary, {
    pending_count: 0,
    in_flight_count: 1,
  });
  const target = createRuntimeRecoveryPort({
    stateRoot: join(source.root, "target-state"),
    packageVersion: "0.0.0",
    storageSchemaVersion: "1",
  });
  const report = await target.restore(snapshot, {
    targetInstanceId: "instance-synthetic",
    restoreIdempotencyKey: "restore-in-flight",
    rollback: "required",
    supportedSnapshotSchemaVersions:
      verifyOptions.supportedSnapshotSchemaVersions,
    supportedStorageSchemaVersions: verifyOptions.supportedStorageSchemaVersions,
    supportedPackageVersions: verifyOptions.supportedPackageVersions,
    supportedContractVersions: verifyOptions.supportedContractVersions,
  });
  assert.deepEqual(report.pending_outbox_state, {
    pending_count: 1,
    in_flight_count: 0,
  });
});

test("restore migrates a supported older storage schema inside Runtime", async (t) => {
  const source = await createFixture(t, "storage-migration");
  const original = await source.recovery.backup({
    instanceId: "instance-synthetic",
    authorityRevision: "revision-synthetic-1",
    outputDirectory: join(source.root, "snapshot"),
    consistency: "transactional_boundary",
  });
  const artifactPath = join(original.directory, "authoritative/state.sqlite");
  await chmod(artifactPath, 0o600);
  const oldDatabase = new DatabaseSync(artifactPath);
  oldDatabase.exec("ALTER TABLE reanswer_outbox DROP COLUMN last_error_code");
  oldDatabase.close();
  const artifactBytes = await readFile(artifactPath);
  const manifest = structuredClone(original.manifest);
  manifest.storage_schema_version = "0";
  manifest.files[0].size = artifactBytes.byteLength;
  manifest.files[0].checksum = checksum(artifactBytes);
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await chmod(join(original.directory, "manifest.json"), 0o600);
  await writeFile(join(original.directory, "manifest.json"), manifestText);
  await chmod(join(original.directory, "artifact.sha256"), 0o600);
  await writeFile(
    join(original.directory, "artifact.sha256"),
    `${checksum(manifestText)}\n`,
  );
  const snapshot = await openRuntimeRecoverySnapshot(original.directory);
  const target = createRuntimeRecoveryPort({
    stateRoot: join(source.root, "target-state"),
    packageVersion: "0.0.0",
    storageSchemaVersion: "1",
  });

  const report = await target.restore(snapshot, {
    targetInstanceId: "instance-synthetic",
    restoreIdempotencyKey: "restore-storage-v0",
    rollback: "required",
    supportedSnapshotSchemaVersions:
      verifyOptions.supportedSnapshotSchemaVersions,
    supportedStorageSchemaVersions: ["0", "1"],
    supportedPackageVersions: verifyOptions.supportedPackageVersions,
    supportedContractVersions: verifyOptions.supportedContractVersions,
  });

  assert.equal(report.integrity_result.status, "pass");
  assert.deepEqual(report.storage_migrations_applied, ["STORAGE_SCHEMA_0_TO_1"]);
});

test("restore interruption rolls the original target back", async (t) => {
  const source = await createFixture(t, "rollback-source");
  const snapshot = await source.recovery.backup({
    instanceId: "instance-synthetic",
    authorityRevision: "revision-synthetic-1",
    outputDirectory: join(source.root, "snapshot"),
    consistency: "transactional_boundary",
  });
  const targetRoot = join(source.root, "target-state");
  const targetDirectory = join(targetRoot, "instance-synthetic");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(targetDirectory, { recursive: true });
  const targetPath = join(targetDirectory, "runtime.sqlite");
  const originalStore = new SqliteReanswerStore({
    databasePath: targetPath,
    initialHead,
  });
  originalStore.close();
  const before = await readFile(targetPath);
  let checks = 0;
  let concurrentRunReason;
  const signal = {
    get aborted() {
      checks += 1;
      if (checks === 2) {
        try {
          markRuntimeInstanceRunServed({
            stateRoot: targetRoot,
            instanceId: "instance-synthetic",
            runId: "run-concurrent-with-restore",
          });
        } catch (error) {
          concurrentRunReason = error.message;
        }
      }
      return checks >= 3;
    },
  };
  const target = createRuntimeRecoveryPort({
    stateRoot: targetRoot,
    packageVersion: "0.0.0",
    storageSchemaVersion: "1",
  });

  const report = await target.restore(snapshot, {
    targetInstanceId: "instance-synthetic",
    restoreIdempotencyKey: "restore-interrupted",
    rollback: "required",
    signal,
    ...verifyOptions,
  });

  assert.deepEqual(await readFile(targetPath), before);
  assert.equal(concurrentRunReason, "RUNTIME_RESTORE_IN_PROGRESS");
  assert.equal(report.integrity_result.status, "fail");
  assert.deepEqual(report.rollback_result, {
    status: "completed",
    reason_codes: ["RESTORE_INTERRUPTED"],
  });
});

test("a process crash after replacement is rolled back on the next restore", async (t) => {
  const source = await createFixture(t, "process-crash-source");
  const snapshot = await source.recovery.backup({
    instanceId: "instance-synthetic",
    authorityRevision: "revision-synthetic-1",
    outputDirectory: join(source.root, "snapshot"),
    consistency: "transactional_boundary",
  });
  const targetRoot = join(source.root, "target-state");
  const targetDirectory = join(targetRoot, "instance-synthetic");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(targetDirectory, { recursive: true });
  const targetPath = join(targetDirectory, "runtime.sqlite");
  const originalStore = new SqliteReanswerStore({
    databasePath: targetPath,
    initialHead,
  });
  originalStore.close();
  const before = await readFile(targetPath);
  const recoveryModule = new URL("../../dist/recovery/index.js", import.meta.url);
  const childScript = `
    import { createRuntimeRecoveryPort, openRuntimeRecoverySnapshot } from ${JSON.stringify(recoveryModule.href)};
    const snapshot = await openRuntimeRecoverySnapshot(${JSON.stringify(snapshot.directory)});
    const recovery = createRuntimeRecoveryPort({ stateRoot: ${JSON.stringify(targetRoot)}, packageVersion: "0.0.0", storageSchemaVersion: "1" });
    let checks = 0;
    const signal = { get aborted() { checks += 1; if (checks >= 3) process.kill(process.pid, "SIGKILL"); return false; } };
    await recovery.restore(snapshot, {
      targetInstanceId: "instance-synthetic",
      restoreIdempotencyKey: "restore-process-crash",
      rollback: "required",
      signal,
      supportedSnapshotSchemaVersions: ["cognitive-runtime.runtime-recovery-snapshot-manifest/v1"],
      supportedStorageSchemaVersions: ["1"],
      supportedPackageVersions: ["0.0.0"],
      supportedContractVersions: ["v1"]
    });
  `;
  const exit = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", childScript]);
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(exit.signal, "SIGKILL");

  assert.equal(
    await recoverInterruptedRuntimeRestore({
      stateRoot: targetRoot,
      instanceId: "instance-synthetic",
    }),
    true,
  );
  assert.deepEqual(await readFile(targetPath), before);

  const target = createRuntimeRecoveryPort({
    stateRoot: targetRoot,
    packageVersion: "0.0.0",
    storageSchemaVersion: "1",
  });
  const options = {
    targetInstanceId: "instance-synthetic",
    restoreIdempotencyKey: "restore-process-crash",
    rollback: "required",
    supportedSnapshotSchemaVersions:
      verifyOptions.supportedSnapshotSchemaVersions,
    supportedStorageSchemaVersions: verifyOptions.supportedStorageSchemaVersions,
    supportedPackageVersions: verifyOptions.supportedPackageVersions,
    supportedContractVersions: verifyOptions.supportedContractVersions,
  };
  const retried = await target.restore(snapshot, options);
  assert.equal(retried.integrity_result.status, "pass");
  assert.equal(retried.restored_active_head.active_seq, 1);
});

test("snapshot loader rejects a changed manifest artifact identity", async (t) => {
  const fixture = await createFixture(t, "manifest");
  const snapshot = await fixture.recovery.backup({
    instanceId: "instance-synthetic",
    authorityRevision: "revision-synthetic-1",
    outputDirectory: join(fixture.root, "snapshot"),
    consistency: "transactional_boundary",
  });
  const copied = join(fixture.root, "copied-snapshot");
  const { cp } = await import("node:fs/promises");
  await cp(snapshot.directory, copied, { recursive: true });
  const manifestPath = join(copied, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.authority_revision = "revision-tampered";
  await chmod(manifestPath, 0o600);
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

  await assert.rejects(
    openRuntimeRecoverySnapshot(copied),
    /SNAPSHOT_ARTIFACT_ID_MISMATCH/,
  );
});
