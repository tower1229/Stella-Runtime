import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const ignoredDirectories = new Set([".git", "node_modules"]);
const allowedTopLevel = new Set([
  ".gitignore",
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
  "skills",
  "src",
  "tests",
  "tsconfig.build.json",
  "tsconfig.json",
]);
const textExtensions = new Set([
  ".js",
  ".json",
  ".map",
  ".md",
  ".mjs",
  ".ts",
]);

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)));
    } else {
      files.push(path);
    }
  }

  return files;
}

test("repository top-level content is allowlisted", async () => {
  const entries = await readdir(repositoryRoot);
  const unexpected = entries.filter(
    (entry) => !ignoredDirectories.has(entry) && !allowedTopLevel.has(entry),
  );

  assert.deepEqual(unexpected, []);
  assert.equal(entries.includes(".gitignore"), true);
});

test("public source contains no common sensitive material", async () => {
  const patterns = [
    ["macOS home path", new RegExp("/" + "Users" + "/")],
    ["Linux home path", new RegExp("/" + "home" + "/")],
    [
      "private key",
      new RegExp("BEGIN (?:RSA |EC |OPENSSH )?" + "PRIVATE KEY"),
    ],
    ["AWS access key", new RegExp("AK" + "IA[0-9A-Z]{16}")],
    [
      "inline credential",
      new RegExp(
        "(?:api[_-]?key|token|password)\\s*[:=]\\s*[\"'][A-Za-z0-9_./+-]{12,}[\"']",
        "i",
      ),
    ],
  ];
  const findings = [];

  for (const path of await listFiles(repositoryRoot)) {
    if (!textExtensions.has(extname(path))) {
      continue;
    }
    const content = await readFile(path, "utf8");
    for (const [name, pattern] of patterns) {
      if (pattern.test(content)) {
        findings.push(`${relative(repositoryRoot, path)}: ${name}`);
      }
    }
  }

  assert.deepEqual(findings, []);
});
