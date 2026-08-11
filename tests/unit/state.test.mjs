import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SqliteStateStore } from "../../dist/state/index.js";

const checksum = (digit) => `sha256:${digit.repeat(64)}`;
const initialHead = {
  active_seq: 0,
  view_version: "view-0",
  checksum: checksum("0"),
  activated_at: "2026-08-11T00:00:00Z",
};

const correction = (sequence, value, overrides = {}) => ({
  event: {
    seq: sequence,
    event_id: `event-${sequence}`,
    state_id: "state-synthetic",
    event_type: "correction",
    payload: { value },
    observed_at: `2026-08-11T00:00:0${sequence}Z`,
    source_kind: "user_explicit",
    idempotency_key: `event-key-${sequence}`,
    created_at: `2026-08-11T00:00:0${sequence}Z`,
    ...overrides,
  },
  outbox: {
    correctionId: `correction-${sequence}`,
    instanceId: "instance-synthetic",
    sessionKeyHash: checksum(String(sequence)),
    priorRunId: `run-prior-${sequence}`,
    idempotencyKey: `outbox-key-${sequence}`,
    createdAt: `2026-08-11T00:00:0${sequence}Z`,
  },
});

test("StatePort reduces an immutable deterministic view by instance and revision", async (t) => {
  const store = new SqliteStateStore({
    databasePath: ":memory:",
    instanceId: "instance-synthetic",
    initialHead,
  });
  t.after(() => store.close());

  await store.correct(correction(1, "first"));
  const first = await store.view({ instanceId: "instance-synthetic" });
  await store.correct(correction(2, "corrected"));
  const historical = await store.view({
    instanceId: "instance-synthetic",
    revision: 1,
  });
  const current = await store.view({ instanceId: "instance-synthetic" });

  assert.deepEqual(historical, first);
  assert.equal(historical.states[0].payload.value, "first");
  assert.equal(current.states[0].payload.value, "corrected");
  assert.notEqual(current.viewVersion, historical.viewVersion);
  assert.match(current.checksum, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(current), true);
  assert.equal(Object.isFrozen(current.states), true);
  assert.equal(Object.isFrozen(current.states[0].payload), true);
  assert.throws(() => {
    current.states[0].payload.value = "mutated";
  }, TypeError);
});

test("StatePort rejects another instance and an unavailable revision", async (t) => {
  const store = new SqliteStateStore({
    databasePath: ":memory:",
    instanceId: "instance-synthetic",
    initialHead,
  });
  t.after(() => store.close());

  await assert.rejects(
    store.view({ instanceId: "instance-other" }),
    /STATE_INSTANCE_MISMATCH/,
  );
  await assert.rejects(
    store.view({ instanceId: "instance-synthetic", revision: 1 }),
    /STATE_REVISION_NOT_FOUND/,
  );
});

test("runtime migration is versioned, repeatable, and failed migration is atomic", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-state-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, "runtime.sqlite");

  new SqliteStateStore({
    databasePath,
    instanceId: "instance-synthetic",
    initialHead,
  }).close();
  new SqliteStateStore({
    databasePath,
    instanceId: "instance-synthetic",
    initialHead,
  }).close();

  const database = new DatabaseSync(databasePath, { readOnly: true });
  const migrations = database
    .prepare("SELECT version, name FROM runtime_schema_migrations ORDER BY version")
    .all()
    .map((row) => ({ version: row.version, name: row.name }));
  assert.deepEqual(migrations, [{ version: 1, name: "current-state-and-reanswer" }]);
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 1);
  database.close();

  const brokenPath = join(root, "broken.sqlite");
  const broken = new DatabaseSync(brokenPath);
  broken.exec("CREATE TABLE state_events(unrelated TEXT NOT NULL)");
  broken.close();
  assert.throws(() => new SqliteStateStore({
    databasePath: brokenPath,
    instanceId: "instance-synthetic",
    initialHead,
  }));
  const afterFailure = new DatabaseSync(brokenPath, { readOnly: true });
  assert.equal(
    afterFailure.prepare(
      "SELECT count(*) AS count FROM sqlite_master WHERE name = 'runtime_schema_migrations'",
    ).get().count,
    0,
  );
  assert.deepEqual(
    afterFailure.prepare("PRAGMA table_info(state_events)").all().map((row) => row.name),
    ["unrelated"],
  );
  afterFailure.close();
});

test("a uniqueness failure rolls back event, head, and outbox together", async (t) => {
  const store = new SqliteStateStore({
    databasePath: ":memory:",
    instanceId: "instance-synthetic",
    initialHead,
  });
  t.after(() => store.close());
  await store.correct(correction(1, "first"));
  const before = await store.view({ instanceId: "instance-synthetic" });

  await assert.rejects(store.correct({
    ...correction(2, "second"),
    event: {
      ...correction(2, "second").event,
      event_id: "event-1",
    },
  }), /UNIQUE constraint failed/);

  assert.deepEqual(
    await store.view({ instanceId: "instance-synthetic" }),
    before,
  );
  assert.equal(store.getEventCount(), 1);
  assert.equal(store.get("correction-2"), null);
});
