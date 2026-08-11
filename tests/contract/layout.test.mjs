import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const requiredDirectories = [
  "src/core",
  "src/openclaw",
  "src/generation",
  "src/router",
  "src/packet",
  "src/state",
  "src/recovery",
  "src/provenance",
  "src/cli",
  "contracts/v1",
  "skills/framework-admission",
  "examples/minimal-user",
  "tests/unit",
  "tests/contract",
  "tests/integration",
  "tests/golden",
  "tests/pack-install",
  "tests/fixtures",
];

test("repository contains every scaffold directory", async () => {
  await Promise.all(
    requiredDirectories.map((path) =>
      access(new URL(`../../${path}/`, import.meta.url)),
    ),
  );
});

test("framework admission is explicitly a non-operational placeholder", async () => {
  const skill = await readFile(
    new URL("../../skills/framework-admission/SKILL.md", import.meta.url),
    "utf8",
  );

  assert.match(skill, /^---\nname: framework-admission\n/m);
  assert.match(skill, /placeholder/i);
  assert.match(skill, /does not implement/i);
});

test("minimal example declares itself synthetic", async () => {
  const example = JSON.parse(
    await readFile(
      new URL("../../examples/minimal-user/example.json", import.meta.url),
      "utf8",
    ),
  );

  assert.equal(example.synthetic, true);
  assert.equal(example.instanceId, "instance-synthetic-example");
});
