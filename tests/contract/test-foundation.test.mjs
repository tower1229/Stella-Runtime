import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
    "normal_restore",
    "pending_outbox_restore",
    "interrupted_restore",
    "repeated_restore",
  ]);
});
