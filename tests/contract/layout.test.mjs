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
  "src/conformance",
  "src/provenance",
  "src/cli",
  "contracts/v2",
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

test("framework admission is operational and shares the Runtime package version", async () => {
  const skill = await readFile(
    new URL("../../skills/framework-admission/SKILL.md", import.meta.url),
    "utf8",
  );
  const packageJson = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );

  assert.match(skill, /^---\nname: framework-admission\n/m);
  assert.match(
    skill,
    new RegExp(`package_version: ${packageJson.version.replaceAll(".", "\\.")}`),
  );
  assert.doesNotMatch(skill, /placeholder/i);
  assert.match(skill, /source author/i);
  assert.match(skill, /model synthesis/i);
  assert.match(skill, /accepted.*rejected.*rewritten/is);
  assert.match(skill, /raw Evidence.*never/is);
  assert.match(skill, /runtime digest/i);
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
