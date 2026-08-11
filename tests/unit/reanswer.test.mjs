import assert from "node:assert/strict";
import test from "node:test";

import { SqliteReanswerStore } from "../../dist/state/index.js";

const checksum = (digit) => `sha256:${digit.repeat(64)}`;
const initialHead = {
  schema_version: "cognitive-runtime.current-state-head/v1",
  active_seq: 0,
  view_version: "view-0",
  checksum: checksum("0"),
  activated_at: "2026-08-11T00:00:00Z",
};

const correction = (id, session = checksum("1")) => ({
  event: {
    schema_version: "cognitive-runtime.current-state-event/v1",
    seq: 1,
    event_id: `event-${id}`,
    state_id: "state-synthetic",
    event_type: "correction",
    payload: { value: "updated" },
    observed_at: "2026-08-11T00:00:01Z",
    source_kind: "user_explicit",
    idempotency_key: `event-key-${id}`,
    created_at: "2026-08-11T00:00:02Z",
  },
  newHead: {
    schema_version: "cognitive-runtime.current-state-head/v1",
    active_seq: 1,
    view_version: `view-${id}`,
    checksum: checksum("2"),
    activated_at: "2026-08-11T00:00:03Z",
  },
  outbox: {
    correctionId: `correction-${id}`,
    instanceId: "instance-synthetic",
    sessionKeyHash: session,
    priorRunId: "run-prior",
    idempotencyKey: `outbox-key-${id}`,
    createdAt: "2026-08-11T00:00:03Z",
  },
});

test("correction atomically commits event, state head, and one outbox record", async (t) => {
  const store = new SqliteReanswerStore({ databasePath: ":memory:", initialHead });
  t.after(() => store.close());

  const first = await store.correct(correction("1"));
  const duplicate = await store.correct(correction("1"));

  assert.equal(first.correction_id, "correction-1");
  assert.equal(first.status, "pending");
  assert.deepEqual(duplicate, first);
  assert.equal(store.getEventCount(), 1);
  assert.equal(store.getHead().view_version, "view-1");
});

test("one session allows at most one non-terminal outbox and rolls back the correction", async (t) => {
  const store = new SqliteReanswerStore({ databasePath: ":memory:", initialHead });
  t.after(() => store.close());
  await store.correct(correction("1"));

  await assert.rejects(store.correct({
    ...correction("2"),
    event: { ...correction("2").event, seq: 2 },
    newHead: { ...correction("2").newHead, active_seq: 2 },
  }), /REANSWER_SESSION_BUSY/);
  assert.equal(store.getEventCount(), 1);
  assert.equal(store.getHead().view_version, "view-1");
});

test("attempt claim is CAS, failure returns pending, and one successor completes once", async (t) => {
  const store = new SqliteReanswerStore({ databasePath: ":memory:", initialHead });
  t.after(() => store.close());
  await store.correct(correction("1"));

  const claims = await Promise.all([
    store.claim("correction-1", { successorRunId: "run-ui-1", deliveryMode: "ui_normal_rpc" }),
    store.claim("correction-1", { successorRunId: "run-ui-2", deliveryMode: "ui_normal_rpc" }),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  const firstClaim = claims.find(Boolean);
  assert.ok(firstClaim);

  await store.release(firstClaim, "HOST_ABORTED");
  assert.equal(store.get("correction-1")?.status, "pending");

  const retry = await store.claim("correction-1", {
    successorRunId: "run-command-1",
    deliveryMode: "command_continuation",
  });
  assert.ok(retry);
  assert.equal(retry.attempt, 2);
  await store.complete(retry);

  const completed = store.get("correction-1");
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.successful_completion_count, 1);
  assert.equal(await store.claim("correction-1", {
    successorRunId: "run-command-2",
    deliveryMode: "command_continuation",
  }), null);
  await assert.rejects(store.complete(retry), /REANSWER_CAS_FAILED/);
});
