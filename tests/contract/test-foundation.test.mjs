import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  calculateInstanceCutoverPlanChecksum,
  validateInstanceCutoverPlan,
} from "../../dist/cutover/index.js";

const readFixture = async (relativePath) => JSON.parse(
  await readFile(new URL(`../fixtures/${relativePath}`, import.meta.url), "utf8"),
);

test("capability fixture pins one exact release channel and host version", async () => {
  const fixture = await readFixture(
    "capabilities/extended-stable/2026.6.34.json",
  );

  assert.equal(fixture.synthetic, true);
  assert.equal(fixture.releaseChannel, "extended-stable");
  assert.equal(fixture.openclawVersion, "2026.6.34");
  assert.doesNotMatch(fixture.openclawVersion, /[<>=~^*]/);
  assert.doesNotMatch(JSON.stringify(fixture), /minimumVersion/i);
});

test("future runtime behavior is reserved at public test boundaries", async () => {
  const fixture = await readFixture("boundaries/runtime.json");

  assert.equal(fixture.synthetic, true);
  assert.deepEqual(Object.keys(fixture.boundaries).sort(), [
    "reanswerOutbox",
    "runScratchMap",
    "strictRouterValidation",
    "successorDelivery",
  ]);
  assert.deepEqual(fixture.boundaries.successorDelivery, [
    "command_continuation",
    "ui_normal_rpc",
  ]);
});

test("recovery fixtures reserve contract and integration failure paths", async () => {
  const contract = await readFixture("recovery/contract.json");
  const integration = await readFixture("recovery/integration.json");
  const scenarioIds = [...contract.scenarios, ...integration.scenarios]
    .map(({ id }) => id);

  assert.equal(contract.synthetic, true);
  assert.equal(contract.layer, "contract");
  assert.equal(integration.synthetic, true);
  assert.equal(integration.layer, "integration");
  assert.deepEqual(scenarioIds, [
    "normal_snapshot",
    "checksum_damaged",
    "storage_schema_incompatible",
    "package_version_incompatible",
    "contract_version_incompatible",
    "instance_mismatch",
    "normal_restore",
    "pending_outbox_restore",
    "interrupted_restore",
    "repeated_restore",
  ]);
});

test("public CangHai cutover fixture is de-identified and binds the complete transition", async () => {
  const fixture = await readFixture("cutover/canghai-public.json");
  const { checksum, ...payload } = fixture;

  assert.equal(calculateInstanceCutoverPlanChecksum(payload), checksum);
  assert.doesNotThrow(() => validateInstanceCutoverPlan(
    fixture,
    "instance-canghai-deidentified",
    "a".repeat(40),
  ));
  assert.deepEqual(fixture.publication_prerequisites, {
    remote_base_check: true,
    push_before_sync: true,
  });
  assert.deepEqual(fixture.remove_retrieval_paths, ["/srv/canghai/private/30_RAG"]);
  assert.deepEqual(fixture.disable_mechanisms, ["active-memory"]);
  assert.deepEqual(fixture.preserve_independent_paths, [
    "/srv/canghai/public-author-corpus",
  ]);
  assert.deepEqual(fixture.bootstrap_targets, ["USER.md", "MEMORY.md"]);
  assert.doesNotMatch(JSON.stringify(fixture), /zangtao|telegram|\.openclaw|workspace-yu/i);
});
