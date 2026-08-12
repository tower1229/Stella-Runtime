import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  activateGeneration,
  buildGeneration,
  loadActiveGeneration,
  verifyGeneration,
} from "../../dist/generation/index.js";
import { writeSyntheticAuthority } from "../helpers/synthetic-authority.mjs";

const canonicalize = (value) => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
};
const canonicalJson = (value) => `${JSON.stringify(canonicalize(value))}\n`;
const checksum = (value) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

test("one authority revision activates one internally consistent generation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-generation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorityDirectory = join(root, "authority");
  const stateDirectory = join(root, "state");
  await writeSyntheticAuthority(authorityDirectory);

  const built = await buildGeneration({
    authorityDirectory,
    stateDirectory,
    sourceRevision: "revision-synthetic-1",
    packageVersion: "0.1.0-beta.0",
  });
  assert.equal((await verifyGeneration(built.stagingDirectory)).valid, true);

  await activateGeneration({
    stateDirectory,
    stagingDirectory: built.stagingDirectory,
  });
  const active = await loadActiveGeneration(stateDirectory);

  assert.equal(active.manifest.sync_generation, built.syncGeneration);
  assert.equal(active.registry.sync_generation, built.syncGeneration);
  assert.equal(active.governingDigest.sync_generation, built.syncGeneration);
  assert.equal(active.memoryProjection.sync_generation, built.syncGeneration);
  assert.equal(active.indexMetadata.sync_generation, built.syncGeneration);
  assert.equal(active.viewProjection.sync_generation, built.syncGeneration);
  assert.deepEqual(
    active.manifest.files.map((file) => file.path),
    [
      "governing-digest.json",
      "index-metadata.json",
      "memory-projection.json",
      "normalized-records.json",
      "registry.json",
      "view-projection.json",
    ],
  );
  assert.equal(active.registry.payload.entries.length, 3);
});

test("coordinated projection tampering fails verification and preserves the active generation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-generation-tamper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorityDirectory = join(root, "authority");
  const stateDirectory = join(root, "state");
  await writeSyntheticAuthority(authorityDirectory);
  const activeBuild = await buildGeneration({
    authorityDirectory,
    stateDirectory,
    sourceRevision: "revision-synthetic-1",
    packageVersion: "0.1.0-beta.0",
  });
  await activateGeneration({
    stateDirectory,
    stagingDirectory: activeBuild.stagingDirectory,
  });

  const candidate = await buildGeneration({
    authorityDirectory,
    stateDirectory,
    sourceRevision: "revision-synthetic-2",
    packageVersion: "0.1.0-beta.0",
  });
  const registryPath = join(candidate.stagingDirectory, "registry.json");
  const manifestPath = join(candidate.stagingDirectory, "manifest.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  registry.payload.entries[0].syncGeneration = activeBuild.syncGeneration;
  registry.content_checksum = checksum(canonicalJson(registry.payload));
  const registryContent = canonicalJson(registry);
  await writeFile(registryPath, registryContent);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files.find((file) => file.path === "registry.json").checksum =
    checksum(registryContent);
  await writeFile(manifestPath, canonicalJson(manifest));

  const verification = await verifyGeneration(candidate.stagingDirectory);
  assert.equal(verification.valid, false);
  assert.ok(verification.issues.includes("MIXED_GENERATION:registry-entry"));
  await assert.rejects(
    activateGeneration({
      stateDirectory,
      stagingDirectory: candidate.stagingDirectory,
    }),
    /GENERATION_VERIFY_FAILED/,
  );
  assert.equal(
    (await loadActiveGeneration(stateDirectory)).manifest.sync_generation,
    activeBuild.syncGeneration,
  );
});

test("build rejects broken references, duplicate stable IDs, and wrong authority roles", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-generation-authority-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const [name, mutate, reason] of [
    ["broken", async (authority) => {
      const path = join(authority, "semantic", "claim.md");
      await writeFile(path, (await readFile(path, "utf8")).replace(
        "source_refs: [src-synthetic-note]",
        "source_refs: [src-missing]",
      ));
    }, /STABLE_REF_NOT_FOUND:src-missing/],
    ["duplicate", async (authority) => {
      await copyFile(
        join(authority, "semantic", "claim.md"),
        join(authority, "semantic", "claim-copy.md"),
      );
    }, /DUPLICATE_STABLE_ID:sem-synthetic-claim/],
    ["wrong-role", async (authority) => {
      await writeFile(
        join(authority, "cognitive-binding.json"),
        `${JSON.stringify({
          schema_version: "cognitive-runtime.cognitive-binding/v1",
          active_governing_system: "cog-synthetic-method",
        })}\n`,
      );
    }, /AUTHORITY_ROLE_MISMATCH:cog-synthetic-method:governing_system/],
  ]) {
    const authority = join(root, name, "authority");
    await writeSyntheticAuthority(authority);
    await mutate(authority);
    await assert.rejects(
      buildGeneration({
        authorityDirectory: authority,
        stateDirectory: join(root, name, "state"),
        sourceRevision: `revision-${name}`,
        packageVersion: "0.1.0-beta.0",
      }),
      reason,
    );
  }
});

test("Evidence originals and assets are preserved but not parsed as authority records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-generation-evidence-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorityDirectory = join(root, "authority");
  await writeSyntheticAuthority(authorityDirectory);
  const sourceDirectory = join(
    authorityDirectory,
    "evidence",
    "src-synthetic-note",
  );
  await mkdir(join(sourceDirectory, "original"), { recursive: true });
  await mkdir(join(sourceDirectory, "assets"), { recursive: true });
  await writeFile(join(sourceDirectory, "original", "raw.md"), "Raw markdown without frontmatter.\n");
  await writeFile(join(sourceDirectory, "assets", "caption.md"), "Asset caption.\n");

  const built = await buildGeneration({
    authorityDirectory,
    stateDirectory: join(root, "state"),
    sourceRevision: "revision-evidence-package",
    packageVersion: "0.1.0-beta.0",
  });
  assert.equal((await verifyGeneration(built.stagingDirectory)).valid, true);
});

test("checksum drift and incomplete staging cannot replace a serving generation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-generation-interrupted-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorityDirectory = join(root, "authority");
  const stateDirectory = join(root, "state");
  await writeSyntheticAuthority(authorityDirectory);
  const activeBuild = await buildGeneration({
    authorityDirectory,
    stateDirectory,
    sourceRevision: "revision-active",
    packageVersion: "0.1.0-beta.0",
  });
  await activateGeneration({ stateDirectory, stagingDirectory: activeBuild.stagingDirectory });

  const candidate = await buildGeneration({
    authorityDirectory,
    stateDirectory,
    sourceRevision: "revision-candidate",
    packageVersion: "0.1.0-beta.0",
  });
  await writeFile(join(candidate.stagingDirectory, "index-metadata.json"), "{}\n");
  const verification = await verifyGeneration(candidate.stagingDirectory);
  assert.equal(verification.valid, false);
  assert.ok(
    verification.issues.includes("FILE_CHECKSUM_MISMATCH:index-metadata.json"),
  );
  await assert.rejects(
    activateGeneration({ stateDirectory, stagingDirectory: candidate.stagingDirectory }),
    /GENERATION_VERIFY_FAILED/,
  );
  assert.equal(
    (await loadActiveGeneration(stateDirectory)).manifest.sync_generation,
    activeBuild.syncGeneration,
  );

  const interrupted = join(stateDirectory, "staging", "generation-interrupted");
  await mkdir(interrupted, { recursive: true });
  await writeFile(join(interrupted, "normalized-records.json"), "{}\n");
  assert.equal((await verifyGeneration(interrupted)).valid, false);
  assert.equal(
    (await loadActiveGeneration(stateDirectory)).manifest.sync_generation,
    activeBuild.syncGeneration,
  );
});

test("atomic activation exposes only complete old or new snapshots to concurrent Runs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-generation-atomic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorityDirectory = join(root, "authority");
  const stateDirectory = join(root, "state");
  await writeSyntheticAuthority(authorityDirectory);
  const first = await buildGeneration({
    authorityDirectory,
    stateDirectory,
    sourceRevision: "revision-first",
    packageVersion: "0.1.0-beta.0",
  });
  await activateGeneration({ stateDirectory, stagingDirectory: first.stagingDirectory });
  const second = await buildGeneration({
    authorityDirectory,
    stateDirectory,
    sourceRevision: "revision-second",
    packageVersion: "0.1.0-beta.0",
  });

  const snapshotsPromise = Promise.all(
    Array.from({ length: 40 }, async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return loadActiveGeneration(stateDirectory);
    }),
  );
  await activateGeneration({ stateDirectory, stagingDirectory: second.stagingDirectory });
  const snapshots = await snapshotsPromise;
  for (const snapshot of snapshots) {
    const generation = snapshot.manifest.sync_generation;
    assert.ok([first.syncGeneration, second.syncGeneration].includes(generation));
    assert.equal(snapshot.registry.sync_generation, generation);
    assert.equal(snapshot.governingDigest.sync_generation, generation);
    assert.equal(snapshot.memoryProjection.sync_generation, generation);
    assert.equal(snapshot.indexMetadata.sync_generation, generation);
    assert.equal(snapshot.viewProjection.sync_generation, generation);
  }
});

test("verification rejects coordinated cross-projection content and role drift", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-generation-projection-drift-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorityDirectory = join(root, "authority");
  const stateDirectory = join(root, "state");
  await writeSyntheticAuthority(authorityDirectory);
  const built = await buildGeneration({
    authorityDirectory,
    stateDirectory,
    sourceRevision: "revision-projection-drift",
    packageVersion: "0.1.0-beta.0",
  });
  const manifestPath = join(built.stagingDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  for (const fileName of ["registry.json", "index-metadata.json", "memory-projection.json"]) {
    const path = join(built.stagingDirectory, fileName);
    const artifact = JSON.parse(await readFile(path, "utf8"));
    const entry = artifact.payload.entries.find((item) => item.id === "cog-synthetic-method");
    entry.role = "governing_module";
    if (fileName === "memory-projection.json") {
      entry.content = "Coordinated but non-authoritative replacement content.";
    }
    if (fileName === "registry.json") {
      const canonicalEntries = [...artifact.payload.entries]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(({ id, role, version, syncGeneration, checksum, governedBy }) => ({
          id, role, version, syncGeneration, checksum,
          ...(governedBy === undefined ? {} : { governedBy }),
        }));
      artifact.payload.checksum = checksum(JSON.stringify(canonicalEntries));
    }
    artifact.content_checksum = checksum(canonicalJson(artifact.payload));
    const content = canonicalJson(artifact);
    await writeFile(path, content);
    manifest.files.find((file) => file.path === fileName).checksum = checksum(content);
  }
  await writeFile(manifestPath, canonicalJson(manifest));

  const verification = await verifyGeneration(built.stagingDirectory);
  assert.equal(verification.valid, false);
  assert.ok(verification.issues.includes("GENERATION_PROJECTION_MISMATCH:registry.json"));
  assert.ok(verification.issues.includes("GENERATION_PROJECTION_MISMATCH:memory-projection.json"));
});
