import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("public documentation covers install, configuration, CLI, data, operations, and limits", async () => {
  const [readme, configuration, boundaries, operations, support, changelog] =
    await Promise.all([
      read("README.md"),
      read("docs/CONFIGURATION.md"),
      read("docs/DATA-BOUNDARIES.md"),
      read("docs/OPERATIONS.md"),
      read("docs/SUPPORT.md"),
      read("CHANGELOG.md"),
    ]);

  assert.match(readme, /npm install --save-exact @tower1229\/stella-cognitive-runtime@0\.1\.0/);
  assert.match(readme, /cognitive self-check/);
  assert.match(readme, /Configuration reference/);
  assert.match(readme, /Known limitations/);
  assert.match(configuration, /off.*observe.*enforce/is);
  assert.match(configuration, /routerTimeoutMs/);
  assert.match(configuration, /activeGoverningSystem/);
  assert.match(configuration, /cognitive (?:self-check|metrics)/);
  assert.match(boundaries, /Authority Repository/);
  assert.match(boundaries, /Runtime Recovery Snapshot/);
  assert.match(boundaries, /must never/is);
  assert.match(operations, /install/i);
  assert.match(operations, /upgrade/i);
  assert.match(operations, /rollback/i);
  assert.match(operations, /backup.*verify.*restore/is);
  assert.match(operations, /0\.1\.0-beta\.0/);
  assert.match(operations, /bootstrap/i);
  assert.match(operations, /npm trust github/);
  assert.match(support, /extended-stable.*2026\.6\.34/is);
  assert.match(support, /consumer product acceptance/i);
  assert.match(changelog, /## \[0\.1\.0\]/);
});

test("exact-host evidence records the stable package acceptance command", async () => {
  const evidence = await read("docs/evidence/openclaw-2026.6.34.md");

  assert.match(evidence, /Package version: `0\.1\.0`/);
  assert.match(evidence, /npm run test:pack-install/);
  assert.match(evidence, /OpenClaw 2026\.6\.34 \(5c38f99\)/);
  assert.match(evidence, /synthetic/i);
});
