import assert from "node:assert/strict";
import { access, copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  activateGeneration,
  buildGeneration,
  loadActiveGeneration,
  showGeneration,
  validateAuthoritySource,
  verifyGeneration,
} from "../../dist/generation/index.js";
import {
  commitAuthorityChanges,
  commitSyntheticPersonalDataRepository,
  commitSyntheticAuthority,
  writeSyntheticAuthority,
} from "../helpers/synthetic-authority.mjs";

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

test("validate reads one exact clean committed Authority revision without mutation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-generation-validate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorityDirectory = join(root, "authority");
  await writeSyntheticAuthority(authorityDirectory);
  const sourceRevision = await commitSyntheticAuthority(authorityDirectory);

  const validated = await validateAuthoritySource({ authorityDirectory, sourceRevision });

  assert.deepEqual(validated, {
    sourceRevision,
    recordCount: 3,
    activeGoverningSystem: null,
  });
  await assert.rejects(
    validateAuthoritySource({ authorityDirectory, sourceRevision: "HEAD" }),
    /SOURCE_REVISION_AMBIGUOUS/,
  );
  await assert.rejects(
    validateAuthoritySource({ authorityDirectory, sourceRevision: "f".repeat(40) }),
    /SOURCE_REVISION_NOT_CHECKED_OUT/,
  );
  await writeFile(join(authorityDirectory, "semantic", "uncommitted.md"), "not an entrypoint\n");
  await assert.rejects(
    validateAuthoritySource({ authorityDirectory, sourceRevision }),
    /AUTHORITY_WORKTREE_DIRTY/,
  );
  await rm(join(authorityDirectory, "semantic", "uncommitted.md"));
  await writeFile(join(authorityDirectory, ".gitignore"), "semantic/ignored/\n");
  const ignoredRevision = await commitAuthorityChanges(authorityDirectory, "ignore legacy input");
  await mkdir(join(authorityDirectory, "semantic", "ignored"), { recursive: true });
  await writeFile(
    join(authorityDirectory, "semantic", "ignored", "claim.md"),
    "Ignored but protocol-shaped input.\n",
  );
  await assert.rejects(
    validateAuthoritySource({ authorityDirectory, sourceRevision: ignoredRevision }),
    /AUTHORITY_ENTRYPOINT_UNCOMMITTED:semantic\/ignored\/claim\.md/,
  );
  await assert.rejects(
    validateAuthoritySource({ authorityDirectory: root, sourceRevision }),
    /AUTHORITY_GIT_REPOSITORY_REQUIRED/,
  );
});

test("legacy standalone Authority remains valid when its path happens to end in stella/authority", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-generation-legacy-layout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorityDirectory = join(root, "stella", "authority");
  await writeSyntheticAuthority(authorityDirectory);
  const sourceRevision = await commitSyntheticAuthority(authorityDirectory);

  assert.equal(
    (await validateAuthoritySource({ authorityDirectory, sourceRevision })).recordCount,
    3,
  );
});

test("build reads only the committed Authority subtree from one Personal Data Repository", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-generation-personal-data-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "personal-data");
  const authorityDirectory = join(repository, "stella", "authority");
  const fitnessDirectory = join(repository, "stella", "fitness");
  const projectionsDirectory = join(repository, "stella", "projections");
  const stateDirectory = join(root, "state");
  await writeSyntheticAuthority(authorityDirectory);
  await mkdir(fitnessDirectory, { recursive: true });
  await mkdir(projectionsDirectory, { recursive: true });
  await writeFile(join(repository, ".gitignore"), "stella/projections/\n");
  const sourceRevision = await commitSyntheticPersonalDataRepository(repository);

  await writeFile(join(fitnessDirectory, "current.json"), "{\"private\":true}\n");
  await mkdir(join(fitnessDirectory, "semantic"), { recursive: true });
  await writeFile(join(fitnessDirectory, "semantic", "claim.md"), "not Authority\n");
  await writeFile(join(projectionsDirectory, "ignored.json"), "{\"derived\":true}\n");

  const validated = await validateAuthoritySource({ authorityDirectory, sourceRevision });
  const built = await buildGeneration({
    authorityDirectory,
    stateDirectory,
    sourceRevision,
    packageVersion: "0.2.1-subtree",
  });

  assert.deepEqual(validated, {
    sourceRevision,
    recordCount: 3,
    activeGoverningSystem: null,
  });
  const normalized = JSON.parse(await readFile(
    join(built.generationDirectory, "normalized-records.json"),
    "utf8",
  ));
  assert.deepEqual(
    normalized.payload.records.map(({ id }) => id),
    ["cog-synthetic-method", "sem-synthetic-claim", "src-synthetic-note"],
  );
  assert.equal(
    normalized.payload.records.find(({ id }) => id === "sem-synthetic-claim").checksum,
    "sha256:e53836d3c19dd902ffe5afeab2eccefc4c555e7adf4347993299fe02c86db6c3",
  );
  assert.equal((await verifyGeneration(built.generationDirectory)).valid, true);

  const trackedFitnessRevision = await commitAuthorityChanges(
    repository,
    "track synthetic Fitness content",
  );
  await writeFile(join(fitnessDirectory, "current.json"), "{\"private\":\"dirty\"}\n");
  assert.equal(
    (await validateAuthoritySource({
      authorityDirectory,
      sourceRevision: trackedFitnessRevision,
    })).recordCount,
    3,
  );

  await writeFile(join(authorityDirectory, "semantic", "untracked.md"), "dirty\n");
  await assert.rejects(
    validateAuthoritySource({ authorityDirectory, sourceRevision: trackedFitnessRevision }),
    /AUTHORITY_WORKTREE_DIRTY/,
  );
  await rm(join(authorityDirectory, "semantic", "untracked.md"));
  await writeFile(join(authorityDirectory, "semantic", "claim.md"), "tracked dirty\n");
  await assert.rejects(
    validateAuthoritySource({ authorityDirectory, sourceRevision: trackedFitnessRevision }),
    /AUTHORITY_WORKTREE_DIRTY/,
  );

  await assert.rejects(
    validateAuthoritySource({
      authorityDirectory: `${fitnessDirectory}/../authority`,
      sourceRevision: trackedFitnessRevision,
    }),
    /AUTHORITY_PATH_TRAVERSAL/,
  );
});

test("Authority subtree validation fails closed on symlinks and nested Git", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-generation-subtree-negative-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const symlinkRepository = join(root, "symlink-repository");
  const symlinkAuthority = join(symlinkRepository, "stella", "authority");
  await writeSyntheticAuthority(symlinkAuthority);
  await writeFile(join(symlinkRepository, ".gitignore"), "stella/projections/\n");
  await symlink("cognitive-binding.json", join(symlinkAuthority, "linked-binding.json"));
  const symlinkRevision = await commitSyntheticPersonalDataRepository(symlinkRepository);
  await assert.rejects(
    validateAuthoritySource({
      authorityDirectory: symlinkAuthority,
      sourceRevision: symlinkRevision,
    }),
    /AUTHORITY_TREE_ENTRY_UNSUPPORTED:linked-binding\.json/,
  );

  const nestedRepository = join(root, "nested-repository");
  const nestedAuthority = join(nestedRepository, "stella", "authority");
  await writeSyntheticAuthority(nestedAuthority);
  await writeFile(join(nestedRepository, ".gitignore"), "stella/projections/\n");
  const parentRevision = await commitSyntheticPersonalDataRepository(nestedRepository);
  await commitSyntheticAuthority(nestedAuthority, "forbidden nested authority repository");
  await assert.rejects(
    validateAuthoritySource({
      authorityDirectory: nestedAuthority,
      sourceRevision: parentRevision,
    }),
    /AUTHORITY_NESTED_GIT_FORBIDDEN/,
  );

  const submoduleRepository = join(root, "submodule-repository");
  const submoduleAuthority = join(submoduleRepository, "stella", "authority");
  await writeSyntheticAuthority(submoduleAuthority);
  await writeFile(join(submoduleRepository, ".gitignore"), "stella/projections/\n");
  await commitSyntheticPersonalDataRepository(submoduleRepository);
  const nestedModule = join(submoduleAuthority, "nested-module");
  await writeSyntheticAuthority(nestedModule);
  await commitSyntheticAuthority(nestedModule, "synthetic nested module");
  const submoduleRevision = await commitAuthorityChanges(
    submoduleRepository,
    "forbidden Authority submodule",
  );
  await assert.rejects(
    validateAuthoritySource({
      authorityDirectory: submoduleAuthority,
      sourceRevision: submoduleRevision,
    }),
    /AUTHORITY_TREE_ENTRY_UNSUPPORTED:nested-module/,
  );

  const ignoredRepository = join(root, "ignored-symlink-repository");
  const ignoredAuthority = join(ignoredRepository, "stella", "authority");
  await writeSyntheticAuthority(ignoredAuthority);
  await writeFile(
    join(ignoredRepository, ".gitignore"),
    "stella/projections/\nstella/authority/ignored-link\n",
  );
  const ignoredRevision = await commitSyntheticPersonalDataRepository(ignoredRepository);
  await symlink("cognitive-binding.json", join(ignoredAuthority, "ignored-link"));
  await assert.rejects(
    validateAuthoritySource({
      authorityDirectory: ignoredAuthority,
      sourceRevision: ignoredRevision,
    }),
    /AUTHORITY_SYMLINK_UNSUPPORTED:ignored-link/,
  );
});

test("Authority subtree validation rejects case-colliding committed paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-generation-case-collision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "personal-data");
  const authorityDirectory = join(repository, "stella", "authority");
  await writeSyntheticAuthority(authorityDirectory);
  await writeFile(join(repository, ".gitignore"), "stella/projections/\n");
  await commitSyntheticPersonalDataRepository(repository);

  const upperDirectory = join(authorityDirectory, "Semantic");
  const caseSensitive = await access(upperDirectory)
    .then(() => false, () => true);
  if (!caseSensitive) return;
  await mkdir(upperDirectory);
  await copyFile(
    join(authorityDirectory, "semantic", "claim.md"),
    join(upperDirectory, "claim.md"),
  );
  const sourceRevision = await commitAuthorityChanges(repository, "case collision");

  await assert.rejects(
    validateAuthoritySource({ authorityDirectory, sourceRevision }),
    /AUTHORITY_PATH_CASE_COLLISION:Semantic\/claim\.md:semantic\/claim\.md|AUTHORITY_PATH_CASE_COLLISION:semantic\/claim\.md:Semantic\/claim\.md/,
  );
});

test("build reuses one immutable full-hash Generation and renders bound projections", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-generation-build-v2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorityDirectory = join(root, "authority");
  const stateDirectory = join(root, "state");
  await writeSyntheticAuthority(authorityDirectory);
  const sourceRevision = await commitSyntheticAuthority(authorityDirectory);

  const first = await buildGeneration({
    authorityDirectory,
    stateDirectory,
    sourceRevision,
    packageVersion: "0.2.0-first",
    bootstrapTargets: ["USER.md", "MEMORY.md"],
  });
  const second = await buildGeneration({
    authorityDirectory,
    stateDirectory,
    sourceRevision,
    packageVersion: "0.2.0-republished",
  });

  assert.equal(first.syncGeneration, second.syncGeneration);
  assert.equal(first.generationDirectory, second.generationDirectory);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.manifest.package_version, "0.2.0-first");
  assert.deepEqual(second.bootstrapProjections, []);
  assert.equal(first.syncGeneration.length, "generation-".length + 64);
  await assert.rejects(access(join(stateDirectory, "active.json")));
  const verification = await verifyGeneration(first.generationDirectory);
  assert.equal(verification.valid, true);
  assert.equal(
    verification.manifestChecksum,
    checksum(await readFile(join(first.generationDirectory, "manifest.json"))),
  );
  const projection = JSON.parse(await readFile(
    join(first.generationDirectory, "projection-entries.json"),
    "utf8",
  ));
  assert.equal(projection.payload.entries.length, 3);
  assert.equal(projection.payload.entries[0].generation_id, first.syncGeneration);
  assert.equal(projection.payload.entries.some((entry) => entry.role === "current_state"), false);
  const semantic = projection.payload.entries.find(
    (entry) => entry.stable_id === "sem-synthetic-claim",
  );
  const documentPath = join(
    first.generationDirectory,
    "projections",
    first.syncGeneration,
    "semantic",
    semantic.role,
    semantic.stable_id,
    `${checksum(semantic.authority_version).slice("sha256:".length)}-${semantic.checksum.slice("sha256:".length)}.md`,
  );
  const document = await readFile(documentPath, "utf8");
  assert.match(document, new RegExp(`generation_id: ${first.syncGeneration}`));
  assert.match(document, /stable_id: sem-synthetic-claim/);
  assert.match(document, /authority_version: "2026-08-11"/);
  assert.match(document, /role: semantic/);
  assert.match(document, new RegExp(`checksum: ${semantic.checksum}`));
  assert.match(document, /source_refs:\n  - src-synthetic-note/);
  assert.deepEqual(first.bootstrapProjections.map((projection) => projection.target), [
    "MEMORY.md",
    "USER.md",
  ]);
  assert.match(await readFile(
    join(stateDirectory, "bootstrap", first.syncGeneration, "USER.md"),
    "utf8",
  ), /sem-synthetic-claim/);
  assert.match(await readFile(
    join(stateDirectory, "bootstrap", first.syncGeneration, "MEMORY.md"),
    "utf8",
  ), /cog-synthetic-method/);

  assert.deepEqual(await showGeneration({
    stateDirectory,
    syncGeneration: first.syncGeneration,
  }), {
    syncGeneration: first.syncGeneration,
    sourceRevision,
    active: false,
    activeGeneration: null,
    activeSourceRevision: null,
  });
  const wrongGeneration = `generation-${"f".repeat(64)}`;
  const wrongDirectory = join(stateDirectory, "generations", wrongGeneration);
  await cp(first.generationDirectory, wrongDirectory, { recursive: true });
  const misplaced = await verifyGeneration(wrongDirectory);
  assert.equal(misplaced.valid, false);
  assert.ok(misplaced.issues.includes("GENERATION_DIRECTORY_MISMATCH"));
  await assert.rejects(
    showGeneration({ stateDirectory, syncGeneration: wrongGeneration }),
    /GENERATION_TARGET_INVALID:GENERATION_DIRECTORY_MISMATCH/,
  );
  await writeFile(join(first.generationDirectory, "rogue.md"), "Unmanifested projection.\n");
  const tampered = await verifyGeneration(first.generationDirectory);
  assert.equal(tampered.valid, false);
  assert.ok(tampered.issues.includes("GENERATION_UNMANIFESTED_FILE:rogue.md"));
});

test("one authority revision activates one internally consistent generation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-generation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorityDirectory = join(root, "authority");
  const stateDirectory = join(root, "state");
  await writeSyntheticAuthority(authorityDirectory);
  const sourceRevision = await commitSyntheticAuthority(authorityDirectory);

  const built = await buildGeneration({
    authorityDirectory,
    stateDirectory,
    sourceRevision,
    packageVersion: "0.1.0-beta.0",
  });
  assert.equal((await verifyGeneration(built.generationDirectory)).valid, true);

  await activateGeneration({
    stateDirectory,
    stagingDirectory: built.generationDirectory,
  });
  const active = await loadActiveGeneration(stateDirectory);

  assert.equal(active.manifest.sync_generation, built.syncGeneration);
  assert.equal(active.registry.sync_generation, built.syncGeneration);
  assert.equal(active.governingDigest.sync_generation, built.syncGeneration);
  assert.equal(active.projectionEntries.sync_generation, built.syncGeneration);
  assert.equal(active.indexMetadata.sync_generation, built.syncGeneration);
  assert.equal(active.viewProjection.sync_generation, built.syncGeneration);
  assert.deepEqual(
    active.manifest.files.map((file) => file.path),
    [
      "governing-digest.json",
      "index-metadata.json",
      "normalized-records.json",
      "projection-entries.json",
      ...active.projectionEntries.payload.entries.map((entry) => join(
        "projections",
        built.syncGeneration,
        entry.layer,
        entry.role,
        entry.stable_id,
        `${checksum(entry.authority_version).slice("sha256:".length)}-${entry.checksum.slice("sha256:".length)}.md`,
      )).sort(),
      "registry.json",
      "view-projection.json",
    ].sort(),
  );
  assert.equal(active.registry.payload.entries.length, 3);
});

test("coordinated projection tampering fails verification and preserves the active generation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-generation-tamper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorityDirectory = join(root, "authority");
  const stateDirectory = join(root, "state");
  await writeSyntheticAuthority(authorityDirectory);
  const activeRevision = await commitSyntheticAuthority(authorityDirectory);
  const activeBuild = await buildGeneration({
    authorityDirectory,
    stateDirectory,
    sourceRevision: activeRevision,
    packageVersion: "0.1.0-beta.0",
  });
  await activateGeneration({
    stateDirectory,
    stagingDirectory: activeBuild.generationDirectory,
  });

  const evidencePath = join(authorityDirectory, "evidence", "src-synthetic-note", "source.md");
  await writeFile(evidencePath, `${await readFile(evidencePath, "utf8")}\nCandidate revision.\n`);
  const candidateRevision = await commitAuthorityChanges(authorityDirectory);

  const candidate = await buildGeneration({
    authorityDirectory,
    stateDirectory,
    sourceRevision: candidateRevision,
    packageVersion: "0.1.0-beta.0",
  });
  const registryPath = join(candidate.generationDirectory, "registry.json");
  const manifestPath = join(candidate.generationDirectory, "manifest.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  registry.payload.entries[0].syncGeneration = activeBuild.syncGeneration;
  registry.content_checksum = checksum(canonicalJson(registry.payload));
  const registryContent = canonicalJson(registry);
  await writeFile(registryPath, registryContent);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files.find((file) => file.path === "registry.json").checksum =
    checksum(registryContent);
  await writeFile(manifestPath, canonicalJson(manifest));

  const verification = await verifyGeneration(candidate.generationDirectory);
  assert.equal(verification.valid, false);
  assert.ok(verification.issues.includes("MIXED_GENERATION:registry-entry"));
  await assert.rejects(
    activateGeneration({
      stateDirectory,
      stagingDirectory: candidate.generationDirectory,
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
      await mkdir(join(authority, "semantic", "duplicate"), { recursive: true });
      await copyFile(
        join(authority, "semantic", "claim.md"),
        join(authority, "semantic", "duplicate", "claim.md"),
      );
    }, /DUPLICATE_STABLE_ID:sem-synthetic-claim/],
    ["wrong-role", async (authority) => {
      await writeFile(
        join(authority, "cognitive-binding.json"),
        `${JSON.stringify({
          schema_version: "cognitive-runtime.cognitive-binding/v2",
          active_governing_system: "cog-synthetic-method",
        })}\n`,
      );
    }, /AUTHORITY_ROLE_MISMATCH:cog-synthetic-method:governing_system/],
  ]) {
    const authority = join(root, name, "authority");
    await writeSyntheticAuthority(authority);
    await mutate(authority);
    const sourceRevision = await commitSyntheticAuthority(authority);
    await assert.rejects(
      buildGeneration({
        authorityDirectory: authority,
        stateDirectory: join(root, name, "state"),
        sourceRevision,
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
  await writeFile(join(sourceDirectory, "original", "source.md"), "Raw markdown without frontmatter.\n");
  await writeFile(join(sourceDirectory, "assets", "source.md"), "Asset caption.\n");
  await writeFile(join(authorityDirectory, "semantic", "legacy.md"), "Legacy arbitrary Markdown.\n");
  const sourceRevision = await commitSyntheticAuthority(authorityDirectory);

  const built = await buildGeneration({
    authorityDirectory,
    stateDirectory: join(root, "state"),
    sourceRevision,
    packageVersion: "0.1.0-beta.0",
  });
  assert.equal((await verifyGeneration(built.generationDirectory)).valid, true);
  const projection = JSON.parse(await readFile(
    join(built.generationDirectory, "projection-entries.json"),
    "utf8",
  ));
  assert.equal(projection.payload.entries.length, 3);
});

test("checksum drift and incomplete staging cannot replace a serving generation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-generation-interrupted-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorityDirectory = join(root, "authority");
  const stateDirectory = join(root, "state");
  await writeSyntheticAuthority(authorityDirectory);
  const activeRevision = await commitSyntheticAuthority(authorityDirectory);
  const activeBuild = await buildGeneration({
    authorityDirectory,
    stateDirectory,
    sourceRevision: activeRevision,
    packageVersion: "0.1.0-beta.0",
  });
  await activateGeneration({ stateDirectory, stagingDirectory: activeBuild.generationDirectory });

  const semanticPath = join(authorityDirectory, "semantic", "claim.md");
  await writeFile(semanticPath, (await readFile(semanticPath, "utf8")).replace(
    "Synthetic claims can be tested.",
    "Synthetic candidate claims can be tested.",
  ));
  const candidateRevision = await commitAuthorityChanges(authorityDirectory);

  const candidate = await buildGeneration({
    authorityDirectory,
    stateDirectory,
    sourceRevision: candidateRevision,
    packageVersion: "0.1.0-beta.0",
  });
  await writeFile(join(candidate.generationDirectory, "index-metadata.json"), "{}\n");
  const verification = await verifyGeneration(candidate.generationDirectory);
  assert.equal(verification.valid, false);
  assert.ok(
    verification.issues.includes("FILE_CHECKSUM_MISMATCH:index-metadata.json"),
  );
  await assert.rejects(
    activateGeneration({ stateDirectory, stagingDirectory: candidate.generationDirectory }),
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
  const firstRevision = await commitSyntheticAuthority(authorityDirectory);
  const first = await buildGeneration({
    authorityDirectory,
    stateDirectory,
    sourceRevision: firstRevision,
    packageVersion: "0.1.0-beta.0",
  });
  await activateGeneration({ stateDirectory, stagingDirectory: first.generationDirectory });
  const semanticPath = join(authorityDirectory, "semantic", "claim.md");
  await writeFile(semanticPath, (await readFile(semanticPath, "utf8")).replace(
    "Synthetic claims can be tested.",
    "Synthetic second claims can be tested.",
  ));
  const secondRevision = await commitAuthorityChanges(authorityDirectory);
  const second = await buildGeneration({
    authorityDirectory,
    stateDirectory,
    sourceRevision: secondRevision,
    packageVersion: "0.1.0-beta.0",
  });

  const snapshotsPromise = Promise.all(
    Array.from({ length: 40 }, async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return loadActiveGeneration(stateDirectory);
    }),
  );
  await activateGeneration({ stateDirectory, stagingDirectory: second.generationDirectory });
  const snapshots = await snapshotsPromise;
  for (const snapshot of snapshots) {
    const generation = snapshot.manifest.sync_generation;
    assert.ok([first.syncGeneration, second.syncGeneration].includes(generation));
    assert.equal(snapshot.registry.sync_generation, generation);
    assert.equal(snapshot.governingDigest.sync_generation, generation);
    assert.equal(snapshot.projectionEntries.sync_generation, generation);
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
  const sourceRevision = await commitSyntheticAuthority(authorityDirectory);
  const built = await buildGeneration({
    authorityDirectory,
    stateDirectory,
    sourceRevision,
    packageVersion: "0.1.0-beta.0",
  });
  const manifestPath = join(built.generationDirectory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  for (const fileName of ["registry.json", "index-metadata.json", "projection-entries.json"]) {
    const path = join(built.generationDirectory, fileName);
    const artifact = JSON.parse(await readFile(path, "utf8"));
    const entry = artifact.payload.entries.find((item) =>
      (item.id ?? item.stable_id) === "cog-synthetic-method");
    entry.role = "governing_module";
    if (fileName === "projection-entries.json") {
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

  const verification = await verifyGeneration(built.generationDirectory);
  assert.equal(verification.valid, false);
  assert.ok(verification.issues.includes("GENERATION_PROJECTION_MISMATCH:registry.json"));
  assert.ok(verification.issues.includes("GENERATION_PROJECTION_MISMATCH:projection-entries.json"));
});
