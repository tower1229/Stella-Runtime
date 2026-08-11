import assert from "node:assert/strict";
import test from "node:test";

import { RunScratchMap } from "../../dist/core/index.js";
import { CompareAndSetRemediation } from "../../dist/packet/index.js";

test("remediation performs at most one compare-and-set revision per Run", async () => {
  const scratch = new RunScratchMap({ capacity: 1, ttlMs: 1_000 });
  await scratch.acquire("run-1", {
    syncGeneration: "generation-1",
    stateViewVersion: "view-1",
    registryChecksum: `sha256:${"a".repeat(64)}`,
  });
  let revision = 4;
  let calls = 0;
  const remediation = new CompareAndSetRemediation({
    scratch,
    compareAndSet: async ({ expectedRevision }) => {
      calls += 1;
      if (expectedRevision !== revision) {
        return { applied: false, revision };
      }
      revision += 1;
      return { applied: true, revision };
    },
  });

  const outcomes = await Promise.all([
    remediation.remediate({ runId: "run-1", expectedRevision: 4 }),
    remediation.remediate({ runId: "run-1", expectedRevision: 4 }),
  ]);

  assert.deepEqual(outcomes, [
    { status: "applied", revision: 5 },
    { status: "already_claimed", revision: null },
  ]);
  assert.equal(calls, 1);
});
