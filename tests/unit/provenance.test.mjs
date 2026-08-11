import assert from "node:assert/strict";
import test from "node:test";

import { SqliteProvenanceStore } from "../../dist/provenance/index.js";

const overlay = (overrides = {}) => ({
  trace_id: "trace-synthetic-1",
  run_id: "run-synthetic-1",
  session_key_hash: `sha256:${"1".repeat(64)}`,
  sync_generation: "generation-synthetic-1",
  knowledge_snapshot: "revision-synthetic-1",
  state_view_version: "state-view-1-synthetic",
  validated_router_result: null,
  cognitive_bindings: [
    { id: "cog-synthetic-governing", status: "injected" },
  ],
  stable_refs: [
    { id: "sem-synthetic-preference", status: "retrieved" },
  ],
  unresolved_conflicts: ["conflict-synthetic"],
  trace_status: "degraded",
  eval_eligible: false,
  created_at: "2026-08-11T00:00:00Z",
  ...overrides,
});

test("ProvenancePort records and returns only validated minimal overlays", async (t) => {
  const store = new SqliteProvenanceStore({ databasePath: ":memory:" });
  t.after(() => store.close());

  const first = await store.record(overlay());
  const duplicate = await store.record(overlay());
  assert.deepEqual(duplicate, first);
  assert.deepEqual(await store.get("trace-synthetic-1"), first);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.stable_refs), true);

  await assert.rejects(store.record({
    ...overlay({ trace_id: "trace-synthetic-private", run_id: "run-synthetic-private" }),
    prompt: "private prompt must not be persisted",
  }), /PROVENANCE_CONTRACT_INVALID/);
  assert.equal(await store.get("trace-synthetic-private"), null);

  await assert.rejects(store.record(overlay({
    trace_id: "trace-synthetic-router-text",
    run_id: "run-synthetic-router-text",
    validated_router_result: {
      memory_route: "required",
      state_refs: [],
      governing: null,
      frameworks: { primary: null, secondary: null },
      retrieval_plan: [{
        layer: "semantic",
        method: "search",
        target: null,
        query: "private user text",
        purpose: "repeat private user text",
      }],
      confidence: 0.5,
      reason_codes: ["RETRIEVAL_REQUIRED"],
    },
  })), /PROVENANCE_ROUTER_RESULT_NOT_MINIMAL/);
  assert.equal(await store.get("trace-synthetic-router-text"), null);
});

test("ProvenancePort queries structured results by run, session, status, and stable ref", async (t) => {
  const store = new SqliteProvenanceStore({ databasePath: ":memory:" });
  t.after(() => store.close());
  await store.record(overlay());
  await store.record(overlay({
    trace_id: "trace-synthetic-2",
    run_id: "run-synthetic-2",
    trace_status: "completed",
    stable_refs: [{ id: "src-synthetic-note", status: "declared_used" }],
    unresolved_conflicts: [],
    eval_eligible: true,
    created_at: "2026-08-11T00:00:01Z",
  }));

  assert.deepEqual(
    (await store.query({ runId: "run-synthetic-2" })).map((item) => item.trace_id),
    ["trace-synthetic-2"],
  );
  assert.deepEqual(
    (await store.query({ traceStatus: "degraded" })).map((item) => item.trace_id),
    ["trace-synthetic-1"],
  );
  assert.deepEqual(
    (await store.query({ stableRef: "src-synthetic-note" })).map((item) => item.trace_id),
    ["trace-synthetic-2"],
  );
  assert.deepEqual(
    (await store.query({
      sessionKeyHash: `sha256:${"1".repeat(64)}`,
      limit: 1,
    })).map((item) => item.trace_id),
    ["trace-synthetic-2"],
  );
});

test("a run can have at most one immutable overlay", async (t) => {
  const store = new SqliteProvenanceStore({ databasePath: ":memory:" });
  t.after(() => store.close());
  await store.record(overlay());

  await assert.rejects(store.record(overlay({
    trace_id: "trace-synthetic-conflict",
  })), /PROVENANCE_RUN_CONFLICT/);
  await assert.rejects(store.record(overlay({
    trace_status: "completed",
  })), /PROVENANCE_TRACE_CONFLICT/);
});
