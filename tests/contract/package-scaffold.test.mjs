import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

test("package exposes only built JavaScript to OpenClaw", async () => {
  const packageJson = await readJson(new URL("../../package.json", import.meta.url));

  assert.equal(packageJson.name, "@tower1229/stella-cognitive-runtime");
  assert.equal(packageJson.license, "MIT");
  assert.equal(packageJson.engines.node, "^22.19.0 || ^24.0.0");
  assert.deepEqual(packageJson.openclaw.extensions, ["./dist/openclaw/index.js"]);
  assert.equal(packageJson.exports["."].import, "./dist/index.js");
  assert.equal(packageJson.exports["."].types, "./dist/index.d.ts");
});

test("public entry does not expose SQLite storage paths", async () => {
  const publicEntry = await import("../../dist/index.js");
  assert.equal("SqliteReanswerStore" in publicEntry, false);
});

test("plugin manifest declares a strict config and packaged Skill", async () => {
  const manifest = await readJson(
    new URL("../../openclaw.plugin.json", import.meta.url),
  );

  assert.equal(manifest.id, "cognitive-runtime");
  assert.equal(manifest.configSchema.type, "object");
  assert.equal(manifest.configSchema.additionalProperties, false);
  assert.deepEqual(manifest.skills, ["skills/framework-admission"]);
  assert.deepEqual(manifest.activation.onCapabilities, ["hook"]);
});
