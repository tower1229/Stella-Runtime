import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse as parseYaml } from "yaml";

test("beta release uses unified verification and tag-gated trusted publishing", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/release-beta.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /tags:\n\s+- "v\*-beta\.\*"/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /environment: npm/);
  assert.match(workflow, /npm run verify:env -- release --json/);
  assert.match(workflow, /\.stella\/verification\/release\.json/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /github\.ref_name/);
  assert.match(workflow, /package\.json/);
  assert.match(
    workflow,
    /test "\$RELEASE_TAG" = "v\$\(node -p "require\('\.\/package\.json'\)\.version"\)"/,
  );
  assert.match(
    workflow,
    /npm publish --provenance --access public --tag beta/,
  );
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN/);
});

test("stable release verifies the immutable tag, package, tarball, and published registry", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/release-stable.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /tags:\n\s+- "v\[0-9\]\*\.\[0-9\]\*\.\[0-9\]\*"/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /attestations: write/);
  assert.match(workflow, /environment: npm/);
  assert.match(workflow, /timeout-minutes: 30/);
  assert.match(workflow, /verify:[\s\S]*permissions:\n\s+contents: read/);
  assert.match(workflow, /publish:[\s\S]*needs: verify/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /actions\/upload-artifact@v7/);
  assert.match(workflow, /actions\/download-artifact@v8/);
  assert.match(workflow, /TARBALL="\.\/release\//);
  assert.match(workflow, /test -f "\$TARBALL"/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm install --global openclaw@2026\.7\.1-2/);
  assert.equal(
    [...workflow.matchAll(/node-version:\s*24\.18\.0/g)].length,
    3,
  );
  assert.doesNotMatch(workflow, /node-version:\s*24\s*(?:#.*)?$/m);
  assert.match(workflow, /2026\.7\.1-2 \(0790d9f\)/);
  assert.match(workflow, /npm run verify:env -- release --json/);
  assert.match(workflow, /\.stella\/verification\/release\.json/);
  assert.match(workflow, /npm publish .*--access public/);
  assert.match(workflow, /npm view/);
  assert.match(workflow, /PUBLISHED_INTEGRITY/);
  assert.match(workflow, /for attempt in \{1\.\.12\}/);
  assert.match(workflow, /sleep 5/);
  assert.match(workflow, /grep -q "E404"/);
  assert.match(workflow, /cat registry-error\.log >&2/);
  assert.match(workflow, /npm install --ignore-scripts --save-exact/);
  assert.match(workflow, /npm audit signatures/);
  assert.match(workflow, /CHANGELOG\.md > release\/notes\.md/);
  assert.match(workflow, /--notes-file release\/notes\.md/);
  assert.doesNotMatch(workflow, /--generate-notes/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /gh release edit/);
  assert.match(workflow, /gh release view/);
  assert.match(workflow, /gh release download/);
  assert.match(workflow, /sha512sum/);
  assert.match(workflow, /actions\/attest-build-provenance@v3/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN/);
  const verificationJob = workflow.slice(
    workflow.indexOf("  verify:"),
    workflow.indexOf("  publish:"),
  );
  assert.doesNotMatch(verificationJob, /id-token: write|contents: write/);
});

test("stable release installs the published registry artifact on the exact Host", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/release-stable.yml", import.meta.url),
    "utf8",
  );

  const registrySmokeIndex = workflow.indexOf("  registry-exact-host-smoke:");
  assert.doesNotThrow(() => parseYaml(workflow));
  assert.notEqual(
    registrySmokeIndex,
    -1,
    "release workflow is missing the post-publish registry exact-host job",
  );
  const registrySmokeJob = workflow.slice(registrySmokeIndex);
  assert.match(registrySmokeJob, /needs: publish/);
  assert.match(registrySmokeJob, /node-version:\s*24\.18\.0/);
  assert.match(registrySmokeJob, /openclaw@2026\.7\.1-2/);
  assert.match(
    registrySmokeJob,
    /STELLA_RUNTIME_INSTALL_SPEC:\s*"@tower1229\/stella-cognitive-runtime@\$\{\{ needs\.publish\.outputs\.version \}\}"/,
  );
  assert.match(
    registrySmokeJob,
    /STELLA_RUNTIME_EXPECTED_INTEGRITY:\s*\$\{\{ needs\.publish\.outputs\.integrity \}\}/,
  );
  assert.match(
    registrySmokeJob,
    /STELLA_RUNTIME_EXPECTED_VERSION:\s*\$\{\{ needs\.publish\.outputs\.version \}\}/,
  );
  assert.match(
    registrySmokeJob,
    /node --test --test-concurrency=1 tests\/pack-install\/openclaw-discovery\.test\.mjs/,
  );
});

test("pull requests and master pushes run capability-separated verification", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/verification.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /branches: \[master\]/);
  assert.match(workflow, /profile: \[pure, network-install, exact-host\]/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /npm run verify:env -- "\$VERIFICATION_PROFILE" --json/);
  assert.match(workflow, /openclaw@2026\.7\.1-2/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /actions\/upload-artifact@v7/);
  assert.match(workflow, /\.stella\/verification\/\$\{\{ matrix\.profile \}\}\.json/);
});

test("every exact-host workflow prepares one pinned Fitness source package", async () => {
  const paths = [
    "../../.github/workflows/verification.yml",
    "../../.github/workflows/release-beta.yml",
    "../../.github/workflows/release-stable.yml",
  ];
  const workflows = await Promise.all(paths.map((path) =>
    readFile(new URL(path, import.meta.url), "utf8")
  ));
  const preparation = await readFile(
    new URL("../../scripts/prepare-exact-fitness.mjs", import.meta.url),
    "utf8",
  );

  assert.match(
    preparation,
    /FITNESS_REVISION = "93612d25e65b631e20ab4a7ba51bf5011c2d1c0b"/,
  );
  assert.match(preparation, /STELLA_FITNESS_PACKAGE_ROOT=/);
  assert.match(preparation, /STELLA_FITNESS_EXPECTED_REVISION=/);
  for (const workflow of workflows) {
    assert.doesNotThrow(() => parseYaml(workflow));
    assert.match(
      workflow,
      /node scripts\/prepare-exact-fitness\.mjs "\$RUNNER_TEMP\/stella-fitness"/,
    );
  }
});

test("dependency changes are reviewed before merge", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/dependency-review.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /actions\/dependency-review-action@v4/);
});
