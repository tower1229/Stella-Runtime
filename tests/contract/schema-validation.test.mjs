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
    ["release-pin", "release-pin"],
    ["conformance-receipt", "conformance-receipt"],
    ["discovery-authorization", "discovery-authorization"],
    ["authority-candidate", "authority-candidate"],
    ["candidate-review-artifact", "candidate-review-artifact"],
    ["approval-message-reference", "approval-message-reference"],
    ["decision-receipt", "decision-receipt"],
    ["change-set", "change-set"],
    ["state-view", "state-view"],
    ["state-import-manifest", "state-import-manifest"],
    ["state-correction-preview", "state-correction-preview"],
    ["state-correction-receipt", "state-correction-receipt"],
    ["generation-manifest", "generation-manifest"],
    ["projection-entry", "projection-entry"],
    ["active-generation-pointer", "active-generation-pointer"],
    ["activation-receipt", "activation-receipt"],
    ["instance-runtime-config", "instance-runtime-config"],
    ["instance-cutover-plan", "instance-cutover-plan"],
    ["generation-manifest-v3", "generation-manifest-v3"],
    ["activation-receipt-v3", "activation-receipt-v3"],
    ["active-generation-pointer-v3", "active-generation-pointer-v3"],
  ];

  for (const [contract, fixture] of cases) {
    const value = await loadFixture("valid", fixture);
    assert.deepEqual(validateContract(contract, value), {
      valid: true,
      errors: [],
    });
    const unknownField = validateContract(contract, {
      ...value,
      unexpected_public_field: true,
    });
    assert.equal(unknownField.valid, false, `${contract} must reject unknown fields`);
    assert.ok(unknownField.errors.some((error) => error.keyword === "additionalProperties"));
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
    ["release-pin", "release-pin-floating-locator"],
    ["conformance-receipt", "conformance-receipt-private-path"],
    ["discovery-authorization", "discovery-authorization-extra-field"],
    ["authority-candidate", "authority-candidate-extra-field"],
    ["candidate-review-artifact", "candidate-review-artifact-extra-field"],
    ["approval-message-reference", "approval-message-reference-extra-field"],
    ["decision-receipt", "decision-receipt-extra-field"],
    ["change-set", "change-set-extra-field"],
    ["state-view", "state-view-extra-field"],
    ["state-import-manifest", "state-import-manifest-extra-field"],
    ["state-correction-preview", "state-correction-preview-extra-field"],
    ["state-correction-receipt", "state-correction-receipt-extra-field"],
    ["generation-manifest", "generation-manifest-extra-field"],
    ["projection-entry", "projection-entry-extra-field"],
    ["active-generation-pointer", "active-generation-pointer-extra-field"],
    ["activation-receipt", "activation-receipt-extra-field"],
    ["instance-runtime-config", "instance-runtime-config-extra-field"],
    ["instance-cutover-plan", "instance-cutover-plan-extra-field"],
    ["generation-manifest-v3", "generation-manifest-v3-unsorted-domains"],
    ["activation-receipt-v3", "activation-receipt-v3-domain-tamper"],
    ["active-generation-pointer-v3", "active-generation-pointer-v3-extra-field"],
  ];

  for (const [contract, fixture] of cases) {
    const value = await loadFixture("invalid", fixture);
    const result = validateContract(contract, value);
    assert.equal(result.valid, false, `${contract} should reject ${fixture}`);
    assert.ok(result.errors.length > 0);
  }
});

test("public contracts form one closed v2 set", async () => {
  const { readdir } = await import("node:fs/promises");
  const contractRoot = new URL("../../contracts/v2/", import.meta.url);
  const names = await readdir(contractRoot);

  assert.equal(names.every((name) => name.endsWith(".schema.json")), true);
  for (const name of names) {
    const schema = JSON.parse(await readFile(new URL(name, contractRoot), "utf8"));
    assert.match(schema.$id, /^cognitive-runtime\.[a-z0-9-]+\/v2$/);
    assert.equal(schema.additionalProperties, false);
  }

  await assert.rejects(readFile(new URL("../../contracts/v1/evidence.schema.json", import.meta.url)));
});

test("composite Generation contracts are published as a separate closed v3 set", async () => {
  const { readdir } = await import("node:fs/promises");
  const contractRoot = new URL("../../contracts/v3/", import.meta.url);
  const names = await readdir(contractRoot);

  assert.deepEqual(names.sort(), [
    "activation-receipt.schema.json",
    "active-generation-pointer.schema.json",
    "generation-manifest.schema.json",
  ]);
  for (const name of names) {
    const schema = JSON.parse(await readFile(new URL(name, contractRoot), "utf8"));
    assert.match(schema.$id, /^cognitive-runtime\.[a-z0-9-]+\/v3$/);
    assert.equal(schema.additionalProperties, false);
  }
});

test("Evidence v2 preserves media and declared temporal precision", async () => {
  const evidence = await loadFixture("valid", "evidence");
  assert.deepEqual(validateContract("evidence", evidence), { valid: true, errors: [] });

  for (const temporal of [
    { value: "2026", precision: "year" },
    { value: "2026-08", precision: "month" },
    { value: "2026-08-14", precision: "day" },
    { value: "2026-08-14T10:30:00+08:00", precision: "instant" },
  ]) {
    assert.equal(validateContract("evidence", { ...evidence, created_at: temporal }).valid, true);
  }

  assert.equal(
    validateContract("evidence", {
      ...evidence,
      created_at: { value: "2026-01-01", precision: "year" },
    }).valid,
    false,
  );
  assert.equal(
    validateContract("evidence", {
      ...evidence,
      media: [{ id: "media-primary", path: "assets/primary.png", role: "primary", importance: "high", caption: "Synthetic diagram" }],
    }).valid,
    false,
  );
});
