import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import test from "node:test";

import { RunScratchMap } from "../../dist/core/index.js";
import { SqliteReanswerStore } from "../../dist/state/index.js";

const checksum = (digit) => `sha256:${digit.repeat(64)}`;
const initialHead = {
  active_seq: 0,
  view_version: "view-0",
  checksum: checksum("0"),
  activated_at: "2026-08-11T00:00:00Z",
};

const correction = (id, session = checksum("1")) => ({
  event: {
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
  assert.equal(store.getHead().view_version, first.new_view_version);
  assert.match(first.new_view_version, /^state-view-1-[a-f0-9]{12}$/);
});

test("one session allows at most one non-terminal outbox and rolls back the correction", async (t) => {
  const store = new SqliteReanswerStore({ databasePath: ":memory:", initialHead });
  t.after(() => store.close());
  await store.correct(correction("1"));

  await assert.rejects(store.correct({
    ...correction("2"),
    event: { ...correction("2").event, seq: 2 },
  }), /REANSWER_SESSION_BUSY/);
  assert.equal(store.getEventCount(), 1);
  assert.equal(store.getHead().active_seq, 1);
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

test("correction rejects a stale or skipped state-head boundary", async (t) => {
  const store = new SqliteReanswerStore({ databasePath: ":memory:", initialHead });
  t.after(() => store.close());

  const skipped = correction("2", checksum("9"));
  await assert.rejects(store.correct({
    ...skipped,
    event: { ...skipped.event, seq: 2 },
  }), /STATE_HEAD_CAS_FAILED/);
  assert.equal(store.getEventCount(), 0);
  assert.equal(store.getHead().active_seq, 0);
});

test("session claim requires a distinct successor run and shares command/UI semantics", async (t) => {
  const store = new SqliteReanswerStore({ databasePath: ":memory:", initialHead });
  t.after(() => store.close());
  const receipt = await store.correct(correction("1"));

  await assert.rejects(store.claimForSession(receipt.session_key_hash, {
    successorRunId: receipt.prior_run_id,
    deliveryMode: "command_continuation",
  }), /REANSWER_SUCCESSOR_RUN_NOT_DISTINCT/);
  assert.equal(await store.claimForSession(checksum("9"), {
    successorRunId: "run-unrelated",
    deliveryMode: "ui_normal_rpc",
  }), null);

  const commandClaim = await store.claimForSession(receipt.session_key_hash, {
    successorRunId: "run-command-successor",
    deliveryMode: "command_continuation",
  });
  assert.ok(commandClaim);
  assert.equal(commandClaim.correctionId, receipt.correction_id);
  assert.equal(commandClaim.sessionKeyHash, receipt.session_key_hash);
  assert.equal(commandClaim.newViewVersion, receipt.new_view_version);
  assert.equal(commandClaim.priorRunId, receipt.prior_run_id);
  await store.release(commandClaim, "HOST_ABORTED");

  const uiClaim = await store.claimForSession(receipt.session_key_hash, {
    successorRunId: "run-ui-successor",
    deliveryMode: "ui_normal_rpc",
  });
  assert.ok(uiClaim);
  assert.equal(uiClaim.correctionId, receipt.correction_id);
  assert.equal(uiClaim.attempt, 2);
});

test("restart preserves durable state and pending attempts but never restores RunScratch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-reanswer-restart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, "runtime.sqlite");
  const beforeRestart = new SqliteReanswerStore({ databasePath, initialHead });
  await beforeRestart.correct(correction("1"));
  const claim = await beforeRestart.claim("correction-1", {
    successorRunId: "run-before-restart",
    deliveryMode: "command_continuation",
  });
  assert.ok(claim);
  await beforeRestart.release(claim, "HOST_RESTARTED");
  beforeRestart.close();

  const afterRestart = new SqliteReanswerStore({ databasePath, initialHead });
  t.after(() => afterRestart.close());
  assert.equal(afterRestart.get("correction-1")?.status, "pending");
  assert.equal(afterRestart.get("correction-1")?.attempt_count, 1);
  assert.equal(afterRestart.getHead().active_seq, 1);

  const scratch = new RunScratchMap({ capacity: 2, ttlMs: 1_000 });
  assert.equal(scratch.inspect("run-before-restart"), null);
});

test("concurrent duplicate corrections across connections return one receipt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-correction-concurrent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, "runtime.sqlite");
  new SqliteReanswerStore({ databasePath, initialHead }).close();
  const workerSource = `
    const { parentPort, workerData } = require("node:worker_threads");
    let store;
    import(workerData.moduleUrl).then(({ SqliteReanswerStore }) => {
      store = new SqliteReanswerStore({
        databasePath: workerData.databasePath,
        initialHead: workerData.initialHead,
      });
      parentPort.postMessage({ ready: true });
    });
    parentPort.on("message", async (message) => {
      if (message !== "go") return;
      try {
        parentPort.postMessage({ receipt: await store.correct(workerData.correction) });
      } catch (error) {
        parentPort.postMessage({ error: String(error) });
      } finally {
        store.close();
      }
    });
  `;
  const workerData = {
    moduleUrl: pathToFileURL(resolve("dist/state/index.js")).href,
    databasePath,
    initialHead,
    correction: correction("1"),
  };
  const workers = [
    new Worker(workerSource, { eval: true, workerData }),
    new Worker(workerSource, { eval: true, workerData }),
  ];
  t.after(() => Promise.all(workers.map((worker) => worker.terminate())));
  await Promise.all(workers.map((worker) => once(worker, "message")));
  for (const worker of workers) {
    worker.postMessage("go");
  }
  const results = await Promise.all(
    workers.map((worker) => once(worker, "message").then(([message]) => message)),
  );

  assert.equal(results.every((result) => result.error === undefined), true);
  assert.deepEqual(results[0].receipt, results[1].receipt);
  const store = new SqliteReanswerStore({ databasePath, initialHead });
  assert.equal(store.getEventCount(), 1);
  store.close();
});
