import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  calculateCurrentStateEventChecksum,
  createExactStateImportPolicy,
  createStateManagementPort,
  prepareStateImportManifest,
} from "../../dist/state/management.js";
import { checksumCanonical } from "../../dist/state/canonical.js";

const checksum = (digit) => `sha256:${digit.repeat(64)}`;
const clock = () => "2026-08-14T00:00:00.000Z";

const importedEvent = (overrides = {}) => ({
  seq: 1,
  event_id: "event-baseline-1",
  state_id: "state-location",
  event_type: "imported_baseline",
  payload: { value: "Shanghai", prior_history: "unknown" },
  observed_at: "2026-08-14T00:00:00.000Z",
  source_kind: "user_confirmed",
  source_ref: "confirmation-cutover-1",
  idempotency_key: "event-baseline-key-1",
  created_at: "2026-08-14T00:00:00.000Z",
  ...overrides,
});

const mapping = (overrides = {}) => ({
  event_id: "event-baseline-1",
  source_kind: "user_confirmed",
  source_ref: "confirmation-cutover-1",
  verification: "Exact value confirmed at cutover",
  ...overrides,
});

const policyFor = (
  event = importedEvent(),
  sourceMapping = mapping(),
) => createExactStateImportPolicy({
  authorizations: [{
    eventId: event.event_id,
    eventChecksum: calculateCurrentStateEventChecksum(event),
    sourceKind: sourceMapping.source_kind,
    sourceRef: sourceMapping.source_ref,
    verification: sourceMapping.verification,
    verifiedAt: clock(),
  }],
  now: clock,
  maxAuthorizationAgeMs: 5 * 60 * 1000,
});

const withPort = async (t, instanceId = "instance-synthetic") => {
  const root = await mkdtemp(join(tmpdir(), "stella-state-management-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    port: createStateManagementPort({ stateRoot: root, instanceId, now: clock }),
  };
};

test("state initialize distinguishes missing state from an immutable empty State View", async (t) => {
  const { port } = await withPort(t);

  await assert.rejects(port.view(), /STATE_STORE_MISSING/);
  const initialized = await port.initialize();
  const view = await port.view();

  assert.equal(initialized.created, true);
  assert.equal(view.schema_version, "cognitive-runtime.state-view/v2");
  assert.equal(view.active_seq, 0);
  assert.deepEqual(view.values, []);
  assert.match(view.checksum, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(view), true);
  assert.equal(Object.isFrozen(view.values), true);
  assert.equal((await port.initialize()).created, false);
  port.close();
});

test("state view distinguishes a lost Head without mutating the damaged store", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-state-lost-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const instanceDirectory = join(root, "instance-lost");
  const databasePath = join(instanceDirectory, "runtime.sqlite");
  await mkdir(instanceDirectory, { recursive: true });
  await writeFile(databasePath, "", "utf8");
  const port = createStateManagementPort({
    stateRoot: root,
    instanceId: "instance-lost",
    now: clock,
  });

  await assert.rejects(port.view(), /STATE_STORE_NOT_INITIALIZED/);
  assert.equal((await stat(databasePath)).size, 0);
  port.close();
});

test("state import validates the complete manifest and commits an exact retry idempotently", async (t) => {
  const { port } = await withPort(t);
  await port.initialize();
  const manifest = await prepareStateImportManifest(port, {
    importId: "import-baseline-1",
    events: [importedEvent()],
    sourceMappings: [mapping()],
    createdAt: clock(),
  });

  const policy = policyFor();
  const first = await port.import(manifest, { policy });
  const repeated = await port.import(manifest, { policy });

  assert.equal(first.imported, true);
  assert.equal(repeated.imported, false);
  assert.deepEqual(repeated.view, first.view);
  assert.deepEqual(first.view.values, [{
    state_id: "state-location",
    value: "Shanghai",
    source_event_id: "event-baseline-1",
  }]);
  const differentManifest = {
    ...manifest,
    import_id: "import-baseline-conflict",
  };
  differentManifest.checksum = (await import("../../dist/index.js"))
    .calculateStateImportManifestChecksum(differentManifest);
  await assert.rejects(
    port.import(differentManifest, { policy }),
    /STATE_IMPORT_IDEMPOTENCY_CONFLICT|STATE_IMPORT_REQUIRES_EMPTY_HEAD/,
  );
  port.close();
});

test("one invalid import event or expected Head leaves the initialized baseline untouched", async (t) => {
  const { port } = await withPort(t);
  await port.initialize();
  const invalidEventManifest = await prepareStateImportManifest(port, {
    importId: "import-invalid-event",
    events: [importedEvent({ source_kind: "model_inference" })],
    sourceMappings: [mapping()],
    createdAt: clock(),
  });
  await assert.rejects(port.import(invalidEventManifest), /STATE_CONTRACT_INVALID/);

  const valid = await prepareStateImportManifest(port, {
    importId: "import-invalid-head",
    events: [importedEvent()],
    sourceMappings: [mapping()],
    createdAt: clock(),
  });
  const invalidHead = {
    ...valid,
    expected_head: { ...valid.expected_head, checksum: checksum("f") },
  };
  await assert.rejects(port.import(invalidHead), /STATE_IMPORT_MANIFEST_CHECKSUM_MISMATCH|STATE_IMPORT_EXPECTED_HEAD_MISMATCH/);

  assert.equal((await port.view()).active_seq, 0);
  port.close();
});

test("CangHai import policy excludes snapshot, diary, tracking, and model-derived sources", async (t) => {
  const authorizedEvent = importedEvent();
  const authorizedMapping = mapping();
  const policy = createExactStateImportPolicy({
    authorizations: [{
      eventId: authorizedEvent.event_id,
      eventChecksum: calculateCurrentStateEventChecksum(authorizedEvent),
      sourceKind: authorizedMapping.source_kind,
      sourceRef: authorizedMapping.source_ref,
      verification: authorizedMapping.verification,
      verifiedAt: clock(),
    }],
    now: clock,
    maxAuthorizationAgeMs: 5 * 60 * 1000,
  });
  for (const sourceKind of ["snapshot", "diary", "tracking", "model_inference"]) {
    const { port } = await withPort(t, `instance-${sourceKind.replace("_", "-")}`);
    await port.initialize();
    const event = importedEvent({
      source_kind: sourceKind,
      source_ref: `${sourceKind.replace("_", "-")}-legacy-1`,
    });
    const manifest = await prepareStateImportManifest(port, {
      importId: `import-${sourceKind.replace("_", "-")}`,
      events: [event],
      sourceMappings: [mapping({
        source_ref: `${sourceKind.replace("_", "-")}-legacy-1`,
      })],
      createdAt: clock(),
    });

    await assert.rejects(
      port.import(manifest, { policy }),
      /STATE_IMPORT_SOURCE_REJECTED|STATE_CONTRACT_INVALID/,
    );
    assert.equal((await port.view()).active_seq, 0);
    port.close();
  }
});

test("exact import policy binds fresh external authorization to the event bytes", async (t) => {
  const { port } = await withPort(t);
  await port.initialize();
  const event = importedEvent();
  const sourceMapping = mapping();
  const alteredManifest = await prepareStateImportManifest(port, {
    importId: "import-exact-authorization",
    events: [{ ...event, payload: { ...event.payload, value: "Altered" } }],
    sourceMappings: [sourceMapping],
    createdAt: clock(),
  });
  const authorization = {
    eventId: event.event_id,
    eventChecksum: calculateCurrentStateEventChecksum(event),
    sourceKind: sourceMapping.source_kind,
    sourceRef: sourceMapping.source_ref,
    verification: sourceMapping.verification,
  };
  const freshPolicy = createExactStateImportPolicy({
    authorizations: [{
      ...authorization,
      verifiedAt: clock(),
    }],
    now: clock,
    maxAuthorizationAgeMs: 5 * 60 * 1000,
  });
  const exactManifest = await prepareStateImportManifest(port, {
    importId: "import-stale-authorization",
    events: [event],
    sourceMappings: [sourceMapping],
    createdAt: clock(),
  });
  const stalePolicy = createExactStateImportPolicy({
    authorizations: [{
      ...authorization,
      verifiedAt: "2026-08-13T00:00:00.000Z",
    }],
    now: clock,
    maxAuthorizationAgeMs: 5 * 60 * 1000,
  });

  await assert.rejects(
    port.import(alteredManifest, { policy: freshPolicy }),
    /STATE_IMPORT_SOURCE_REJECTED/,
  );
  await assert.rejects(
    port.import(exactManifest, { policy: stalePolicy }),
    /STATE_IMPORT_SOURCE_REJECTED/,
  );
  assert.equal((await port.view()).active_seq, 0);
  port.close();
});

test("state import is unavailable after the first real Run", async (t) => {
  const { port } = await withPort(t);
  await port.initialize();
  const manifest = await prepareStateImportManifest(port, {
    importId: "import-too-late",
    events: [importedEvent()],
    sourceMappings: [mapping()],
    createdAt: clock(),
  });
  port.markRunServed("run-real-1");

  await assert.rejects(
    port.import(manifest, { policy: policyFor() }),
    /STATE_IMPORT_AFTER_FIRST_RUN/,
  );
  assert.equal((await port.view()).active_seq, 0);
  port.close();
});

test("state correct applies one exact Preview and exposes the new view without touching Generation", async (t) => {
  const { root, port } = await withPort(t);
  await port.initialize();
  const generationDirectory = join(root, "generations", "generation-existing");
  await mkdir(generationDirectory, { recursive: true });
  const generationMarker = join(generationDirectory, "manifest.json");
  await writeFile(generationMarker, "unchanged", "utf8");
  const preview = await port.planCorrection({
    previewId: "preview-1",
    event: importedEvent({
      event_id: "event-correction-1",
      event_type: "correction",
      source_ref: undefined,
      idempotency_key: "event-correction-key-1",
    }),
    expiresAt: "2026-08-15T00:00:00.000Z",
  });
  const conflictingPreview = await port.planCorrection({
    previewId: "preview-conflict-1",
    event: preview.proposed_event,
    expiresAt: preview.expires_at,
  });

  await assert.rejects(port.applyCorrection({
    preview,
    previewChecksum: checksum("f"),
    correctionId: "correction-1",
    sessionKeyHash: checksum("1"),
    priorRunId: "run-prior-1",
    outboxIdempotencyKey: "outbox-key-1",
  }), /STATE_CORRECTION_PREVIEW_CHECKSUM_MISMATCH/);
  assert.equal((await port.view()).active_seq, 0);

  const { preview_checksum: _previewChecksum, ...crossInstanceBody } = preview;
  const crossInstancePreview = {
    ...crossInstanceBody,
    instance_id: "instance-other",
    preview_checksum: checksumCanonical({
      ...crossInstanceBody,
      instance_id: "instance-other",
    }),
  };
  await assert.rejects(port.applyCorrection({
    preview: crossInstancePreview,
    previewChecksum: crossInstancePreview.preview_checksum,
    correctionId: "correction-cross-instance",
    sessionKeyHash: checksum("1"),
    priorRunId: "run-prior-cross-instance",
    outboxIdempotencyKey: "outbox-key-cross-instance",
  }), /STATE_CORRECTION_INSTANCE_MISMATCH/);
  assert.equal((await port.view()).active_seq, 0);

  const applied = await port.applyCorrection({
    preview,
    previewChecksum: preview.preview_checksum,
    correctionId: "correction-1",
    sessionKeyHash: checksum("1"),
    priorRunId: "run-prior-1",
    outboxIdempotencyKey: "outbox-key-1",
  });
  const nextRunView = await port.view();
  const repeated = await port.applyCorrection({
    preview,
    previewChecksum: preview.preview_checksum,
    correctionId: "correction-1",
    sessionKeyHash: checksum("1"),
    priorRunId: "run-prior-1",
    outboxIdempotencyKey: "outbox-key-1",
  });

  assert.equal(applied.view.active_seq, 1);
  assert.deepEqual(nextRunView, applied.view);
  assert.deepEqual(repeated, applied);
  await assert.rejects(port.applyCorrection({
    preview: conflictingPreview,
    previewChecksum: conflictingPreview.preview_checksum,
    correctionId: "correction-1",
    sessionKeyHash: checksum("1"),
    priorRunId: "run-prior-1",
    outboxIdempotencyKey: "outbox-key-1",
  }), /STATE_CORRECTION_IDEMPOTENCY_CONFLICT/);
  assert.equal(await (await import("node:fs/promises")).readFile(generationMarker, "utf8"), "unchanged");
  port.close();
});

test("confirmed-channel correction consumes one exact Receipt and rejects base drift", async (t) => {
  const { port } = await withPort(t);
  await port.initialize();
  const preview = await port.planCorrection({
    previewId: "preview-confirmed-1",
    event: importedEvent({
      event_id: "event-confirmed-1",
      event_type: "correction",
      source_ref: undefined,
      idempotency_key: "event-confirmed-key-1",
    }),
    expiresAt: "2026-08-15T00:00:00.000Z",
  });
  const receipt = {
    schema_version: "cognitive-runtime.state-correction-receipt/v2",
    receipt_id: "receipt-confirmed-1",
    preview_id: preview.preview_id,
    preview_checksum: preview.preview_checksum,
    base_state_view_checksum: preview.base_state_view_checksum,
    confirmed_by: "owner-synthetic",
    confirmation_method: "confirmed_channel",
    confirmed_at: clock(),
    single_use: true,
  };

  const applied = await port.applyCorrection({
    preview,
    receipt,
    correctionId: "correction-confirmed-1",
    sessionKeyHash: checksum("2"),
    priorRunId: "run-prior-confirmed-1",
    outboxIdempotencyKey: receipt.receipt_id,
  });
  assert.equal(applied.outbox.idempotency_key, receipt.receipt_id);

  await assert.rejects(port.applyCorrection({
    preview,
    receipt,
    correctionId: "correction-confirmed-reuse",
    sessionKeyHash: checksum("3"),
    priorRunId: "run-prior-confirmed-2",
    outboxIdempotencyKey: receipt.receipt_id,
  }), /STATE_CORRECTION_BASE_VIEW_MISMATCH/);
  port.close();
});

test("historical State Views remain exact and public management is available from the package root", async (t) => {
  const publicEntry = await import("../../dist/index.js");
  assert.equal(typeof publicEntry.createStateManagementPort, "function");
  const root = await mkdtemp(join(tmpdir(), "stella-state-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let tick = 0;
  const port = publicEntry.createStateManagementPort({
    stateRoot: root,
    instanceId: "instance-history",
    now: () => `2026-08-14T00:00:0${tick++}.000Z`,
  });
  const initialized = await port.initialize();
  const preview = await port.planCorrection({
    previewId: "preview-history-1",
    event: importedEvent({
      event_id: "event-history-1",
      event_type: "correction",
      source_ref: undefined,
      idempotency_key: "event-history-key-1",
      created_at: "2026-08-14T00:00:04.000Z",
    }),
    expiresAt: "2026-08-15T00:00:00.000Z",
  });
  await port.applyCorrection({
    preview,
    previewChecksum: preview.preview_checksum,
    correctionId: "correction-history-1",
    sessionKeyHash: checksum("4"),
    priorRunId: "run-prior-history-1",
    outboxIdempotencyKey: "outbox-history-key-1",
  });

  assert.deepEqual(await port.view({ revision: 0 }), initialized.view);
  port.close();
});

test("historical view fails closed when a migrated store has no provable activation time", async (t) => {
  const { root, port } = await withPort(t, "instance-migrated-history");
  await port.initialize();
  const preview = await port.planCorrection({
    previewId: "preview-migrated-history-1",
    event: importedEvent({
      event_id: "event-migrated-history-1",
      event_type: "correction",
      source_ref: undefined,
      idempotency_key: "event-migrated-history-key-1",
    }),
    expiresAt: "2026-08-15T00:00:00.000Z",
  });
  await port.applyCorrection({
    preview,
    previewChecksum: preview.preview_checksum,
    correctionId: "correction-migrated-history-1",
    sessionKeyHash: checksum("6"),
    priorRunId: "run-prior-migrated-history-1",
    outboxIdempotencyKey: "outbox-migrated-history-key-1",
  });
  port.close();
  const database = new DatabaseSync(join(root, "instance-migrated-history", "runtime.sqlite"));
  database.prepare("DELETE FROM state_view_history WHERE active_seq = 0").run();
  database.close();
  const reopened = createStateManagementPort({
    stateRoot: root,
    instanceId: "instance-migrated-history",
    now: clock,
  });

  await assert.rejects(
    reopened.view({ revision: 0 }),
    /STATE_VIEW_HISTORY_MISSING:0/,
  );
  reopened.close();
});
