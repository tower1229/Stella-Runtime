import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateContract } from "../../dist/contracts/index.js";

const readFixture = async (kind, name) => JSON.parse(await readFile(
  new URL(`../fixtures/contracts/${kind}/${name}.json`, import.meta.url),
  "utf8",
));

test("Personal Data locator contract requires one real instance and absolute repository", async () => {
  const valid = await readFixture("valid", "personal-data-locator");
  assert.deepEqual(validateContract("personal-data-locator", valid), {
    valid: true,
    errors: [],
  });

  for (const name of [
    "personal-data-locator-relative-repository",
    "personal-data-locator-extra-field",
  ]) {
    assert.equal(
      validateContract("personal-data-locator", await readFixture("invalid", name)).valid,
      false,
    );
  }
});

test("projection pointer, manifest, and identity context contracts are closed and bounded", async () => {
  for (const contract of [
    "context-projection-pointer",
    "context-projection-manifest",
    "identity-context",
  ]) {
    const valid = await readFixture("valid", contract);
    assert.deepEqual(validateContract(contract, valid), {
      valid: true,
      errors: [],
    });
    assert.equal(validateContract(contract, {
      ...valid,
      unexpected_public_field: true,
    }).valid, false);
  }

  for (const [contract, fixture] of [
    ["context-projection-pointer", "context-projection-pointer-blocked-revision"],
    ["context-projection-pointer", "context-projection-pointer-stale-tuple"],
    ["context-projection-manifest", "context-projection-manifest-oversize"],
    ["context-projection-manifest", "context-projection-manifest-pair"],
    ["identity-context", "identity-context-unknown-category"],
  ]) {
    assert.equal(
      validateContract(contract, await readFixture("invalid", fixture)).valid,
      false,
      `${contract} should reject ${fixture}`,
    );
  }
});
