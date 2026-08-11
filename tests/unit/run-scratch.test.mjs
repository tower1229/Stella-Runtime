import assert from "node:assert/strict";
import test from "node:test";

import { RunScratchMap } from "../../dist/core/index.js";
import { MemoryObservationAdapter } from "../../dist/openclaw/ports.js";

const binding = {
  syncGeneration: "generation-1",
  authorityRevision: "authority-revision-1",
  stateViewVersion: "view-1",
  registryChecksum: `sha256:${"a".repeat(64)}`,
  stateView: { active: { state: "synthetic" } },
  routerResult: { memory_route: "none" },
};

test("scratch pins one immutable binding and records concurrent observations idempotently", async () => {
  const scratch = new RunScratchMap({ capacity: 2, ttlMs: 1_000 });
  const acquired = await scratch.acquire("run-1", binding);
  assert.equal(Object.isFrozen(acquired.binding), true);
  binding.stateView.active.state = "mutated-after-acquire";
  assert.equal(acquired.binding.stateView.active.state, "synthetic");

  await Promise.all([
    scratch.observe("run-1", { toolCallId: "tool-1", stableRefs: ["sem-a"] }),
    scratch.observe("run-1", { toolCallId: "tool-2", stableRefs: ["sem-b"] }),
    scratch.observe("run-1", { toolCallId: "tool-1", stableRefs: ["sem-duplicate"] }),
  ]);

  assert.deepEqual(scratch.inspect("run-1")?.observations, [
    { toolCallId: "tool-1", stableRefs: ["sem-a"] },
    { toolCallId: "tool-2", stableRefs: ["sem-b"] },
  ]);
  await assert.rejects(
    scratch.acquire("run-1", { ...binding, stateViewVersion: "view-2" }),
    /RUN_BINDING_CONFLICT/,
  );
});

test("scratch refuses capacity and clears by TTL and lifecycle", async () => {
  let now = 1_000;
  const scratch = new RunScratchMap({
    capacity: 1,
    ttlMs: 50,
    now: () => now,
  });
  await scratch.acquire("run-1", binding);
  await assert.rejects(scratch.acquire("run-2", binding), /RUN_SCRATCH_CAPACITY/);

  now += 51;
  assert.equal(scratch.cleanupExpired(), 1);
  await scratch.acquire("run-2", binding);
  assert.equal(scratch.clearLifecycle("restart"), 1);
  assert.equal(scratch.inspect("run-2"), null);
});

test("remediation is claimed at most once per Run", async () => {
  const scratch = new RunScratchMap({ capacity: 1, ttlMs: 1_000 });
  await scratch.acquire("run-1", binding);

  assert.deepEqual(await Promise.all([
    scratch.claimRemediation("run-1"),
    scratch.claimRemediation("run-1"),
  ]), [true, false]);
});

test("memory observation parses stable refs from content/details once per toolCallId", () => {
  const adapter = new MemoryObservationAdapter();
  const first = adapter.observe({
    toolCallId: "tool-memory-1",
    content: [{ type: "text", stable_refs: ["sem-synthetic", "src-synthetic"] }],
    details: { results: [{ claim_id: "sem-synthetic" }, { source_id: "src-other" }] },
  });

  assert.deepEqual(first, {
    toolCallId: "tool-memory-1",
    stableRefs: ["sem-synthetic", "src-synthetic", "src-other"],
  });
  assert.equal(adapter.observe({
    toolCallId: "tool-memory-1",
    details: { stable_refs: ["sem-late"] },
  }), null);
  assert.equal(adapter.observe({ toolCallId: "tool-memory-2", content: "no refs" }), null);
});
