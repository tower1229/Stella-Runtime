import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { findSensitiveMaterial } from "../helpers/public-content.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL("../../", import.meta.url);

test("npm tarball contains only allowlisted and non-sensitive public assets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-runtime-pack-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", root],
    {
      cwd: repositoryRoot,
      env: { ...process.env, npm_config_cache: join(root, "npm-cache") },
    },
  );
  const [pack] = JSON.parse(stdout);
  assert.equal(pack.name, "@tower1229/stella-cognitive-runtime");
  assert.equal(pack.version, "0.2.0");
  const paths = pack.files.map((file) => file.path);
  const allowed = [
    "LICENSE",
    "CHANGELOG.md",
    "README.md",
    "package.json",
    "openclaw.plugin.json",
    "compatibility/",
    "contracts/v2/",
    "docs/CONFIGURATION.md",
    "docs/DATA-BOUNDARIES.md",
    "docs/OPERATIONS.md",
    "docs/SUPPORT.md",
    "docs/evidence/",
    "dist/",
    "skills/framework-admission/",
  ];

  assert.equal(
    paths.every((path) =>
      allowed.some((prefix) =>
        prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix,
      ),
    ),
    true,
  );
  assert.equal(paths.includes("dist/openclaw/index.js"), true);
  assert.equal(paths.includes("CHANGELOG.md"), true);
  assert.equal(paths.includes("dist/testing/runner.js"), true);
  assert.equal(paths.includes("dist/testing/runner.d.ts"), true);
  assert.equal(
    paths.includes(
      "contracts/v2/runtime-recovery-snapshot-manifest.schema.json",
    ),
    true,
  );
  assert.equal(
    paths.includes("contracts/v2/runtime-recovery-report.schema.json"),
    true,
  );
  assert.equal(paths.includes("contracts/v2/release-pin.schema.json"), true);
  assert.equal(
    paths.includes("contracts/v2/conformance-receipt.schema.json"),
    true,
  );
  assert.equal(paths.includes("dist/conformance/index.js"), true);
  assert.equal(paths.includes("dist/conformance/index.d.ts"), true);
  assert.equal(
    paths.includes("skills/framework-admission/SKILL.md"),
    true,
  );
  assert.equal(
    paths.includes("docs/evidence/openclaw-2026.6.34.md"),
    true,
  );
  for (const documentation of [
    "docs/CONFIGURATION.md",
    "docs/DATA-BOUNDARIES.md",
    "docs/OPERATIONS.md",
    "docs/SUPPORT.md",
  ]) {
    assert.equal(paths.includes(documentation), true);
  }
  assert.equal(paths.some((path) => /(?<!\.d)\.ts$/.test(path)), false);

  await execFileAsync(
    "tar",
    ["-xzf", join(root, pack.filename), "-C", root],
  );
  const packageRoot = join(root, "package");
  assert.deepEqual(await findSensitiveMaterial(packageRoot), []);
});
