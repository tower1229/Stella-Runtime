import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { findSensitiveMaterial } from "../helpers/public-content.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const ignoredDirectories = new Set([".git", "node_modules"]);
const allowedTopLevel = new Set([
  ".gitignore",
  ".github",
  "CHANGELOG.md",
  "CONTEXT.md",
  "LICENSE",
  "README.md",
  "compatibility",
  "contracts",
  "docs",
  "dist",
  "examples",
  "openclaw.plugin.json",
  "package-lock.json",
  "package.json",
  "scripts",
  "skills",
  "src",
  "tests",
  "tsconfig.build.json",
  "tsconfig.json",
]);

test("repository top-level content is allowlisted", async () => {
  const entries = await readdir(repositoryRoot);
  const unexpected = entries.filter(
    (entry) => !ignoredDirectories.has(entry) && !allowedTopLevel.has(entry),
  );

  assert.deepEqual(unexpected, []);
  assert.equal(entries.includes(".gitignore"), true);
});

test("public source contains no common sensitive material", async () => {
  assert.deepEqual(
    await findSensitiveMaterial(repositoryRoot, { ignoredDirectories }),
    [],
  );
});
