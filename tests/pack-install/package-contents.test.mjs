import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL("../../", import.meta.url);

test("npm tarball contains only allowlisted public package assets", async () => {
  const cache = await mkdtemp(join(tmpdir(), "stella-runtime-npm-cache-"));
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--json", "--dry-run", "--ignore-scripts"],
    {
      cwd: repositoryRoot,
      env: { ...process.env, npm_config_cache: cache },
    },
  );
  const [pack] = JSON.parse(stdout);
  const paths = pack.files.map((file) => file.path);
  const allowed = [
    "LICENSE",
    "README.md",
    "package.json",
    "openclaw.plugin.json",
    "compatibility/",
    "contracts/v1/",
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
  assert.equal(paths.includes("dist/testing/runner.js"), true);
  assert.equal(paths.includes("dist/testing/runner.d.ts"), true);
  assert.equal(
    paths.includes(
      "contracts/v1/runtime-recovery-snapshot-manifest.schema.json",
    ),
    true,
  );
  assert.equal(
    paths.includes("skills/framework-admission/SKILL.md"),
    true,
  );
  assert.equal(
    paths.includes("docs/evidence/openclaw-2026.6.34.md"),
    true,
  );
  assert.equal(paths.some((path) => /(?<!\.d)\.ts$/.test(path)), false);
});
