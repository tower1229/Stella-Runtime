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

  assert.match(readme, /stable release candidate: `0\.2\.0`/i);
  assert.match(readme, /not yet published/i);
  assert.match(readme, /Node\.js `24\.18\.0` exactly/);
  assert.match(readme, /npm install --save-exact @tower1229\/stella-cognitive-runtime@0\.2\.0/);
  assert.match(readme, /cognitive self-check/);
  assert.match(readme, /Configuration reference/);
  assert.match(readme, /Known limitations/);
  assert.match(configuration, /off.*observe.*enforce/is);
  assert.match(configuration, /max_active_runs/);
  assert.match(configuration, /active-generation\.json/);
  assert.match(configuration, /openclaw cognitive sync --revision/);
  assert.match(configuration, /maintenance-gate\.json/);
  assert.match(configuration, /sync-journal\.json/);
  assert.match(configuration, /cognitive (?:self-check|metrics)/);
  assert.match(boundaries, /Authority Repository/);
  assert.match(boundaries, /Runtime Recovery Snapshot/);
  assert.match(boundaries, /must never/is);
  assert.match(operations, /install/i);
  assert.match(operations, /upgrade/i);
  assert.match(operations, /rollback/i);
  assert.match(operations, /backup.*verify.*restore/is);
  assert.match(operations, /@tower1229\/stella-cognitive-runtime@0\.1\.0/);
  assert.match(operations, /rollback version/i);
  assert.match(operations, /Node\.js is exactly `24\.18\.0`/);
  assert.match(operations, /bootstrap/i);
  assert.match(operations, /npm trust github/);
  assert.match(support, /`0\.2\.0` stable release candidate.*not yet published/is);
  assert.match(support, /engines.*package-install boundary.*not.*compatibility/is);
  assert.match(support, /extended-stable.*2026\.6\.34/is);
  assert.match(support, /consumer product acceptance/i);
  assert.match(changelog, /## \[Unreleased\]\s*\n\s*## \[0\.2\.0\] - 2026-08-20/);
  assert.match(changelog, /\[Unreleased\]: .*\/compare\/v0\.2\.0\.\.\.HEAD/);
  assert.match(changelog, /\[0\.2\.0\]: .*\/compare\/v0\.1\.0\.\.\.v0\.2\.0/);
});

test("exact-host evidence records the stable package acceptance command", async () => {
  const evidence = await read("docs/evidence/openclaw-2026.6.34.md");

  assert.match(evidence, /Stable release candidate: `0\.2\.0` on Node\.js `24\.18\.0`/);
  assert.match(evidence, /Previous rollback version: published `0\.1\.0`/);
  assert.match(evidence, /npm run test:pack-install/);
  assert.match(evidence, /OpenClaw 2026\.6\.34 \(5c38f99\)/);
  assert.match(evidence, /synthetic/i);
});

test("Generation Consumption evidence names the unified release profile and exact scope", async () => {
  const evidence = await read("docs/evidence/openclaw-2026.6.34.md");

  assert.match(evidence, /npm run verify:env -- release --json/);
  assert.match(evidence, /generation-consumption-public-runner/);
  assert.match(evidence, /OpenClaw `2026\.6\.34 \(5c38f99\)` and Node\.js `24\.18\.0`/);
  assert.match(evidence, /does not claim that `0\.2\.0` is published/);
  assert.match(evidence, /source-bound.*revision/is);
});
