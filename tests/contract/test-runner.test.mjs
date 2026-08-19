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

test("Runner drives the public deidentified CangHai Instance Test Pack", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "stella-runtime-canghai-pack-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryTests = path.join(root, "repository-tests");
  const receiptPath = path.join(root, "canghai-receipt.json");
  await mkdir(path.join(repositoryTests, "unit"), { recursive: true });
  await writeFile(
    path.join(repositoryTests, "unit", "repository.test.mjs"),
    `import test from "node:test"; test("repository gate", () => {});\n`,
  );

  const result = spawnSync(
    process.execPath,
    [
      new URL("../../dist/testing/runner.js", import.meta.url).pathname,
      "--repository-test-root",
      repositoryTests,
      "--instance-test-pack",
      new URL("../fixtures/instance-packs/canghai-public", import.meta.url).pathname,
    ],
    {
      encoding: "utf8",
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"),
        ),
        STELLA_RUNTIME_PUBLIC_PACK_RECEIPT: receiptPath,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /INSTANCE_TEST_PACK_PASSED/);
  assert.deepEqual(JSON.parse(await readFile(receiptPath, "utf8")), {
    status: "pass",
    planId: "cutover-canghai-public",
    pushBeforeSync: true,
    legacyRemoval: true,
    activeMemoryDisabled: true,
    bootstrapTargets: ["USER.md", "MEMORY.md"],
    publicCorpusAdapter: "canghai-public-corpus",
  });
});

test("Runner emits only a bounded receipt for a failing external Instance Test Pack", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "stella-runtime-runner-private-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const repositoryTests = path.join(root, "repository-tests");
  const instanceTestPack = path.join(root, "private-instance-pack-sentinel");
  await Promise.all([
    mkdir(path.join(repositoryTests, "unit"), { recursive: true }),
    mkdir(instanceTestPack, { recursive: true }),
  ]);
  await writeFile(
    path.join(repositoryTests, "unit", "repository.test.mjs"),
    `import test from "node:test"; test("public synthetic pass", () => {});\n`,
  );
  await writeFile(
    path.join(instanceTestPack, "consumer.test.mjs"),
    `import assert from "node:assert/strict"; import test from "node:test"; test("consumer conformance failure", () => { assert.equal(process.cwd(), ${JSON.stringify(instanceTestPack)}); assert.equal(process.env.NODE_V8_COVERAGE, undefined); assert.equal(process.env.NODE_OPTIONS, undefined); throw new Error("CONSUMER_ASSERTION_FAILED"); });\n`,
  );

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
        [...Object.entries(process.env).filter(([key]) => !["NODE_TEST_CONTEXT", "NODE_OPTIONS"].includes(key)), ["NODE_V8_COVERAGE", path.join(root, "public-coverage")], ["NODE_OPTIONS", "--test-reporter-destination=private-results.xml"]],
      ),
    },
  );

  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, new RegExp(instanceTestPack.replaceAll("/", "\\/")));
  assert.doesNotMatch(result.stderr, new RegExp(instanceTestPack.replaceAll("/", "\\/")));
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /consumer conformance failure/i);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /CONSUMER_ASSERTION_FAILED/);
  assert.match(`${result.stdout}${result.stderr}`, /INSTANCE_TEST_PACK_FAILED/);
});

test("Runner does not echo an invalid external Instance Test Pack path", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "stella-runtime-runner-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryTests = path.join(root, "repository-tests");
  const privateMissingPath = path.join(root, "private-missing-pack-sentinel");
  await mkdir(path.join(repositoryTests, "unit"), { recursive: true });
  await writeFile(
    path.join(repositoryTests, "unit", "repository.test.mjs"),
    `import test from "node:test"; test("public synthetic pass", () => {});\n`,
  );

  const result = spawnSync(process.execPath, [
    new URL("../../dist/testing/runner.js", import.meta.url).pathname,
    "--repository-test-root", repositoryTests,
    "--instance-test-pack", privateMissingPath,
  ], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /private-missing-pack-sentinel/);
  assert.match(`${result.stdout}${result.stderr}`, /INSTANCE_TEST_PACK_INVALID/);
});
