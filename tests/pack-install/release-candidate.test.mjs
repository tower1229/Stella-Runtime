import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL("../../", import.meta.url);
const previousVerifiedRevision = "1260ba888ea84e0a0d0da0f72c6c9c0db532d323";

test("release candidate upgrades between exact tarballs and verifies version and integrity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-runtime-release-candidate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = join(root, "npm-cache");
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", root],
    { cwd: repositoryRoot, env: { ...process.env, npm_config_cache: cache } },
  );
  const [packed] = JSON.parse(stdout);
  const tarball = join(root, packed.filename);
  const integrity = `sha512-${createHash("sha512")
    .update(await readFile(tarball))
    .digest("base64")}`;
  assert.equal(integrity, packed.integrity);
  const reproductionRoot = join(root, "reproduced");
  await mkdir(reproductionRoot);
  const { stdout: reproducedOutput } = await execFileAsync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", reproductionRoot],
    { cwd: repositoryRoot, env: { ...process.env, npm_config_cache: cache } },
  );
  const [reproduced] = JSON.parse(reproducedOutput);
  assert.equal(reproduced.integrity, packed.integrity);
  assert.deepEqual(
    await readFile(join(reproductionRoot, reproduced.filename)),
    await readFile(tarball),
  );
  const { createReleaseProvenance } = await import("../../dist/index.js");
  const { stdout: sourceRevision } = await execFileAsync(
    "git", ["rev-parse", "HEAD"], { cwd: repositoryRoot },
  );
  const provenance = createReleaseProvenance({
    sourceRevision: sourceRevision.trim(),
    lockfile: await readFile(new URL("../../package-lock.json", import.meta.url)),
    buildCommands: ["npm ci", "npm test", "npm pack --json"],
    tarball: await readFile(tarball),
    reproducedTarball: await readFile(join(reproductionRoot, reproduced.filename)),
    expectedIntegrity: integrity,
  });
  assert.equal(provenance.reproduced_tarball_sha512, integrity);

  const previousRoot = join(root, "previous");
  const previousArchive = join(root, "previous.tar");
  await mkdir(previousRoot);
  await execFileAsync(
    "git",
    ["archive", "--format=tar", `--output=${previousArchive}`, previousVerifiedRevision],
    { cwd: repositoryRoot },
  );
  await execFileAsync("tar", ["-xf", previousArchive, "-C", previousRoot]);
  const previousPackage = JSON.parse(
    await readFile(join(previousRoot, "package.json"), "utf8"),
  );
  assert.equal(previousPackage.version, "0.1.0-beta.0");
  await execFileAsync("npm", ["ci", "--ignore-scripts"], {
    cwd: previousRoot,
    env: { ...process.env, npm_config_cache: cache },
  });
  const { stdout: previousPackOutput } = await execFileAsync(
    "npm", ["pack", "--json", "--pack-destination", root],
    { cwd: previousRoot, env: { ...process.env, npm_config_cache: cache } },
  );
  const [previousPacked] = JSON.parse(previousPackOutput);
  assert.equal(previousPacked.version, "0.1.0-beta.0");
  const previousTarball = join(root, previousPacked.filename);

  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "synthetic-release-consumer",
    version: "1.0.0",
    private: true,
  }, null, 2)}\n`);
  await execFileAsync(
    "npm",
    ["install", "--ignore-scripts", previousTarball],
    { cwd: root, env: { ...process.env, npm_config_cache: cache } },
  );
  const installedPath = join(
    root, "node_modules", "@tower1229", "stella-cognitive-runtime", "package.json",
  );
  assert.equal(JSON.parse(await readFile(installedPath, "utf8")).version, "0.1.0-beta.0");
  await execFileAsync(
    "npm",
    ["install", "--ignore-scripts", tarball],
    { cwd: root, env: { ...process.env, npm_config_cache: cache } },
  );

  const installed = JSON.parse(await readFile(installedPath, "utf8"));
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const lockEntry = lock.packages["node_modules/@tower1229/stella-cognitive-runtime"];
  assert.ok(lockEntry);
  assert.equal(installed.name, "@tower1229/stella-cognitive-runtime");
  assert.equal(installed.version, packed.version);
  assert.equal(lockEntry.version, packed.version);
  assert.equal(lockEntry.integrity, integrity);
  assert.match(lockEntry.resolved, new RegExp(`^file:.*${packed.filename.replaceAll(".", "\\.")}$`));
});
