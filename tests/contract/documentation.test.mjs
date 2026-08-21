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

  assert.match(readme, /published stable release: `0\.2\.1`/i);
  assert.doesNotMatch(readme, /not yet published|stable release candidate/i);
  assert.match(readme, /Node\.js `24\.18\.0` exactly/);
  assert.match(readme, /npm install --save-exact @tower1229\/stella-cognitive-runtime@0\.2\.1/);
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
  assert.match(boundaries, /Runtime repository \| Generic source.*synthetic fixtures/is);
  assert.match(boundaries, /npm package \| Compiled Runtime/is);
  assert.doesNotMatch(boundaries, /Runtime repository and npm package/);
  assert.match(operations, /install/i);
  assert.match(operations, /upgrade/i);
  assert.match(operations, /rollback/i);
  assert.match(operations, /backup.*verify.*restore/is);
  assert.match(operations, /@tower1229\/stella-cognitive-runtime@0\.2\.0/);
  assert.match(operations, /rollback version/i);
  assert.match(operations, /published on 2026-08-20/i);
  assert.match(operations, /4e0000f4227a9ec7bf12e9b9ac0d7ca87f2f515b/);
  assert.match(operations, /Node\.js is exactly `24\.18\.0`/);
  assert.match(operations, /bootstrap/i);
  assert.match(operations, /npm trust github/);
  assert.match(support, /`0\.2\.1` is the published stable release/i);
  assert.doesNotMatch(support, /not yet published|release candidate/i);
  assert.match(support, /engines.*package-install boundary.*not.*compatibility/is);
  assert.match(support, /extended-stable.*2026\.6\.34/is);
  assert.match(support, /consumer product acceptance/i);
  assert.match(changelog, /## \[Unreleased\]\s*\n\s*## \[0\.2\.1\] - 2026-08-21/);
  assert.match(changelog, /\[Unreleased\]: .*\/compare\/v0\.2\.1\.\.\.HEAD/);
  assert.match(changelog, /\[0\.2\.1\]: .*\/compare\/v0\.2\.0\.\.\.v0\.2\.1/);
  assert.match(changelog, /\[0\.2\.0\]: .*\/compare\/v0\.1\.0\.\.\.v0\.2\.0/);
  assert.match(changelog, /persistent.*Approval Receipt/is);
  assert.match(changelog, /periodic reconciliation.*health/is);
  assert.match(changelog, /post-publish registry exact-host/is);
  assert.match(changelog, /Gateway CLI Runs.*before_agent_run/is);
  assert.match(changelog, /canonical JSON ordering.*locale/is);
});

test("exact-host evidence records the stable package acceptance command", async () => {
  const evidence = await read("docs/evidence/openclaw-2026.6.34.md");

  assert.match(evidence, /Published stable release: `0\.2\.1` on Node\.js `24\.18\.0`/);
  assert.match(evidence, /Previous rollback version: published `0\.2\.0`/);
  assert.match(evidence, /npm run test:pack-install/);
  assert.match(evidence, /OpenClaw 2026\.6\.34 \(5c38f99\)/);
  assert.match(evidence, /synthetic/i);
});

test("Generation Consumption evidence names the unified release profile and exact scope", async () => {
  const evidence = await read("docs/evidence/openclaw-2026.6.34.md");

  assert.match(evidence, /npm run verify:env -- release --json/);
  assert.match(evidence, /generation-consumption-public-runner/);
  assert.match(evidence, /OpenClaw `2026\.6\.34 \(5c38f99\)` and Node\.js `24\.18\.0`/);
  assert.match(evidence, /published on 2026-08-20/);
  assert.match(evidence, /source-bound.*revision/is);
});

test("historical V1 documents defer to the completed v2 release baseline", async () => {
  const [requirements, architecture, roadmap, background] = await Promise.all([
    read("docs/requirements/V1.md"),
    read("docs/architecture/V1.md"),
    read("docs/roadmap/V1.md"),
    read("docs/PROJECT-BACKGROUND.md"),
  ]);

  assert.match(requirements, /Status: historical 0\.1 baseline/);
  assert.match(requirements, /current public Contract Set.*\/v2/is);
  assert.match(architecture, /Status: historical 0\.1 architecture/);
  assert.match(roadmap, /Status: historical 0\.1 sequence with completed 0\.2 extension/);
  assert.match(roadmap, /#11.*#31/is);
  assert.match(
    background,
    /Schema namespace \(current\).*`cognitive-runtime\.<contract>\/v2`/,
  );
  assert.doesNotMatch(background, /remaining V1 implementation issues/i);
});

test("accepted CLI ADRs use only shipped sync options", async () => {
  const [operations, projections] = await Promise.all([
    read("docs/adr/0015-the-public-cli-exposes-complete-domain-operations.md"),
    read("docs/adr/0016-generation-consumption-uses-versioned-projection-documents.md"),
  ]);

  assert.match(operations, /sync --revision/);
  assert.doesNotMatch(operations, /--source-revision/);
  assert.doesNotMatch(projections, /--force/);
});
