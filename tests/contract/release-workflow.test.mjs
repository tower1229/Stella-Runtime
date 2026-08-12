import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("beta release uses tag-gated npm trusted publishing with provenance", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/release-beta.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /tags:\n\s+- "v\*-beta\.\*"/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /environment: npm/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run test:pack-install/);
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
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm run lint/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run test:pack-install/);
  assert.match(workflow, /npm publish .*--access public/);
  assert.match(workflow, /npm view/);
  assert.match(workflow, /npm audit signatures/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /actions\/attest-build-provenance@v3/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN/);
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
