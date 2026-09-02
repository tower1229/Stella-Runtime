import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

test("package exposes only built JavaScript to OpenClaw", async () => {
  const packageJson = await readJson(new URL("../../package.json", import.meta.url));

  assert.equal(packageJson.name, "@tower1229/stella-cognitive-runtime");
  assert.equal(packageJson.license, "MIT");
  assert.equal(packageJson.engines.node, "^22.19.0 || ^24.0.0");
  assert.equal(packageJson.version, "0.3.0");
  assert.deepEqual(packageJson.publishConfig, {
    access: "public",
    provenance: true,
  });
  assert.deepEqual(packageJson.openclaw.extensions, ["./dist/openclaw/index.js"]);
  assert.equal(packageJson.exports["."].import, "./dist/index.js");
  assert.equal(packageJson.exports["."].types, "./dist/index.d.ts");
  assert.equal(packageJson.exports["./contracts/v2/*"], "./contracts/v2/*");
  assert.equal(
    packageJson.exports["./contracts/stella/v1/*"],
    "./contracts/stella/v1/*",
  );
  assert.equal("./contracts/v1/*" in packageJson.exports, false);
  assert.equal(packageJson.files.includes("contracts/v2"), true);
  assert.equal(packageJson.files.includes("contracts/stella/v1"), true);
  assert.equal(packageJson.files.includes("contracts/v1"), false);
  assert.deepEqual(packageJson.exports["./test-runner"], {
    types: "./dist/testing/runner.d.ts",
    import: "./dist/testing/runner.js",
  });
  assert.equal(
    packageJson.bin["stella-runtime-test"],
    "./dist/testing/runner.js",
  );
});

test("public entry does not expose SQLite storage paths", async () => {
  const publicEntry = await import("../../dist/index.js");
  assert.equal("SqliteReanswerStore" in publicEntry, false);
  assert.equal(typeof publicEntry.runReleaseConformance, "function");
  assert.equal(typeof publicEntry.createReleaseProvenance, "function");
  assert.equal(typeof publicEntry.rehearseRecoveryTransport, "function");
  assert.equal(typeof publicEntry.resolvePersonalDataLocator, "function");
  assert.equal(typeof publicEntry.initializePersonalDataRepository, "function");
  assert.equal(typeof publicEntry.runProjectionProducerConformance, "function");
  assert.equal(typeof publicEntry.runProjectionConsumerConformance, "function");
  assert.equal(typeof publicEntry.createStateManagementPort, "function");
  assert.equal(typeof publicEntry.createExactStateImportPolicy, "function");
  assert.equal(typeof publicEntry.validateAuthoritySource, "function");
  assert.equal(typeof publicEntry.buildGeneration, "function");
  assert.equal(typeof publicEntry.showGeneration, "function");
  assert.equal(typeof publicEntry.syncGeneration, "function");
  assert.equal(typeof publicEntry.loadMaintenanceGate, "function");
  assert.equal(typeof publicEntry.recoverInterruptedSync, "function");
  assert.equal(typeof publicEntry.FileBindingCompiler, "function");
  assert.equal(typeof publicEntry.calculateRuntimeConfigIdentityChecksum, "function");
  assert.equal("activateGeneration" in publicEntry, false);
  assert.equal("rebuildGeneration" in publicEntry, false);
  assert.equal("runtimeDatabasePath" in publicEntry, false);
});

test("plugin manifest declares a strict config and packaged Skill", async () => {
  const manifest = await readJson(
    new URL("../../openclaw.plugin.json", import.meta.url),
  );

  assert.equal(manifest.id, "cognitive-runtime");
  assert.equal(manifest.version, "0.3.0");
  assert.equal(manifest.configSchema.type, "object");
  assert.equal(manifest.configSchema.additionalProperties, false);
  assert.deepEqual(
    manifest.configSchema.properties.stella.required,
    ["schema_version", "instance_id", "personal_data_repository"],
  );
  assert.equal(
    manifest.configSchema.properties.stella.properties.schema_version.const,
    "stella.personal-data-locator/v1",
  );
  assert.equal("binding" in manifest.configSchema.properties.runtime.properties, false);
  assert.deepEqual(
    manifest.configSchema.properties.runtime.required,
    ["schema_version", "instance_id", "mode", "runtime_storage", "generation_storage", "host", "authority_owner", "limits", "adapters"],
  );
  assert.deepEqual(manifest.skills, ["skills/framework-admission"]);
  assert.deepEqual(manifest.activation.onCapabilities, ["hook"]);
});

test("every public release surface carries the source package version", async () => {
  const packageJson = await readJson(new URL("../../package.json", import.meta.url));
  const packageLock = await readJson(new URL("../../package-lock.json", import.meta.url));
  const manifest = await readJson(new URL("../../openclaw.plugin.json", import.meta.url));
  const compatibility = await readJson(
    new URL("../../compatibility/openclaw.json", import.meta.url),
  );
  const skill = await readFile(
    new URL("../../skills/framework-admission/SKILL.md", import.meta.url),
    "utf8",
  );

  assert.equal(packageJson.version, "0.3.0");
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[""].version, packageJson.version);
  assert.equal(manifest.version, packageJson.version);
  assert.equal(compatibility.packageVersion, packageJson.version);
  assert.match(skill, /^\s+package_version: 0\.3\.0$/m);
});
