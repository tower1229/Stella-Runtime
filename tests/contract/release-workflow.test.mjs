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
  assert.match(workflow, /timeout-minutes: 30/);
  assert.match(workflow, /verify:[\s\S]*permissions:\n\s+contents: read/);
  assert.match(workflow, /publish:[\s\S]*needs: verify/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /actions\/download-artifact@v4/);
  assert.match(workflow, /TARBALL="\.\/release\//);
  assert.match(workflow, /test -f "\$TARBALL"/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm install --global openclaw@2026\.6\.34/);
  assert.match(workflow, /2026\.6\.34 \(5c38f99\)/);
  assert.match(workflow, /npm run lint/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run test:pack-install/);
  assert.match(workflow, /npm publish .*--access public/);
  assert.match(workflow, /npm view/);
  assert.match(workflow, /PUBLISHED_INTEGRITY/);
  assert.match(workflow, /for attempt in \{1\.\.12\}/);
  assert.match(workflow, /sleep 5/);
  assert.match(workflow, /grep -q "E404"/);
  assert.match(workflow, /cat registry-error\.log >&2/);
  assert.match(workflow, /npm install --ignore-scripts --save-exact/);
  assert.match(workflow, /npm audit signatures/);
  assert.match(workflow, /gh release create/);
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

test("dependency changes are reviewed before merge", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/dependency-review.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /actions\/dependency-review-action@v4/);
});
