import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateContract } from "../../dist/contracts/index.js";

const loadFixture = async (kind, name) =>
  JSON.parse(
    await readFile(
      new URL(`../fixtures/contracts/${kind}/${name}.json`, import.meta.url),
      "utf8",
    ),
  );

test("contract validator accepts independent positive fixtures", async () => {
  const cases = [
    ["evidence", "evidence"],
    ["semantic", "semantic"],
    ["personal-model", "personal-model"],
    ["cognitive", "cognitive"],
    ["cognitive-binding", "cognitive-binding"],
    ["current-state-event", "current-state-event"],
    ["current-state-head", "current-state-head"],
    ["reanswer-outbox", "reanswer-outbox"],
    ["cognitive-provenance-overlay", "cognitive-provenance-overlay"],
    ["router-result", "router-result"],
    ["runtime-recovery-snapshot-manifest", "recovery-manifest"],
    ["runtime-recovery-report", "recovery-report"],
    ["runtime-recovery-report-v2", "recovery-report-v2"],
  ];

  for (const [contract, fixture] of cases) {
    const value = await loadFixture("valid", fixture);
    assert.deepEqual(validateContract(contract, value), {
      valid: true,
      errors: [],
    });
  }
});

test("contract validator rejects independent negative fixtures", async () => {
  const cases = [
    ["evidence", "evidence-extra-lifecycle"],
    ["semantic", "semantic-numeric-confidence"],
    ["personal-model", "personal-model-missing-revision-trigger"],
    ["cognitive", "cognitive-unknown-relation"],
    ["cognitive-binding", "cognitive-binding-extra-content"],
    ["current-state-event", "current-state-event-cognitive-layer"],
    ["current-state-head", "current-state-head-bad-checksum"],
    ["reanswer-outbox", "reanswer-outbox-two-successes"],
    ["cognitive-provenance-overlay", "overlay-private-body"],
    ["router-result", "router-result-extra-chain-of-thought"],
    ["runtime-recovery-snapshot-manifest", "recovery-manifest-credential-file"],
    ["runtime-recovery-report", "recovery-report-live-database-path"],
    ["runtime-recovery-report-v2", "recovery-report-v2-live-database-path"],
  ];

  for (const [contract, fixture] of cases) {
    const value = await loadFixture("invalid", fixture);
    const result = validateContract(contract, value);
    assert.equal(result.valid, false, `${contract} should reject ${fixture}`);
    assert.ok(result.errors.length > 0);
  }
});
