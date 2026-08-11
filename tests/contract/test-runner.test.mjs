import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("Runner executes an optional external Instance Test Pack", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "stella-runtime-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const repositoryTests = path.join(root, "repository-tests");
  const instanceTestPack = path.join(root, "instance-test-pack");
  const repositoryMarker = path.join(root, "repository-ran");
  const instanceMarker = path.join(root, "instance-ran");
  await Promise.all([
    mkdir(path.join(repositoryTests, "unit"), { recursive: true }),
    mkdir(instanceTestPack, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(repositoryTests, "unit", "repository.test.mjs"),
      `import { writeFileSync } from "node:fs"; import test from "node:test"; test("repository synthetic fixture", () => { writeFileSync(${JSON.stringify(repositoryMarker)}, "yes"); });\n`,
    ),
    writeFile(
      path.join(instanceTestPack, "consumer.test.mjs"),
      `import { writeFileSync } from "node:fs"; import test from "node:test"; test("external synthetic fixture", () => { writeFileSync(${JSON.stringify(instanceMarker)}, "yes"); });\n`,
    ),
  ]);

  const result = spawnSync(
    process.execPath,
    [
      new URL("../../dist/testing/runner.js", import.meta.url).pathname,
      "--repository-test-root",
      repositoryTests,
      "--instance-test-pack",
      instanceTestPack,
    ],
    {
      encoding: "utf8",
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"),
      ),
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(await readFile(repositoryMarker, "utf8"), "yes");
  assert.equal(await readFile(instanceMarker, "utf8"), "yes");
});
