import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

import {
  lintAuthorityRecord,
  parseAuthorityMarkdown,
  resolveStableId,
  type AuthorityRecord,
} from "../authority/index.js";
import { validateContract } from "../contracts/index.js";
import {
  calculateRegistryChecksum,
  type RegistryRole,
  type RouterRegistryEntry,
} from "../router/index.js";

const CONTRACT_VERSION = "v2";
const GENERATION_PATTERN = /^generation-[a-f0-9]{64}$/;
const CHECKSUM_PATTERN = /^sha256:[a-f0-9]{64}$/;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

interface NormalizedRecord {
  readonly id: string;
  readonly layer: AuthorityRecord["layer"];
  readonly role: RegistryRole;
  readonly record_type: string;
  readonly schema_version: string;
  readonly version: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly body: string;
  readonly sections: readonly {
    readonly title: string;
    readonly content: string;
  }[];
  readonly checksum: string;
}

export interface GenerationArtifact<TPayload = unknown> {
  readonly contract_version: string;
  readonly package_version: string;
  readonly source_revision: string;
  readonly sync_generation: string;
  readonly content_checksum: string;
  readonly payload: TPayload;
}

export interface GenerationManifestFile {
  readonly path: string;
  readonly checksum: string;
  readonly dependencies: readonly string[];
}

export interface GenerationManifest {
  readonly schema_version: "cognitive-runtime.generation-manifest/v2";
  readonly contract_version: string;
  readonly package_version: string;
  readonly source_revision: string;
  readonly sync_generation: string;
  readonly files: readonly GenerationManifestFile[];
}

export interface GenerationBuildOptions {
  readonly authorityDirectory: string;
  readonly stateDirectory: string;
  readonly sourceRevision: string;
  readonly packageVersion: string;
}

export interface GenerationBuildResult {
  readonly syncGeneration: string;
  readonly stagingDirectory: string;
  readonly manifest: GenerationManifest;
}

export interface GenerationVerificationResult {
  readonly valid: boolean;
  readonly issues: readonly string[];
  readonly manifest: GenerationManifest | null;
}

interface RegistryPayload {
  readonly checksum: string;
  readonly entries: readonly RouterRegistryEntry[];
}

interface GoverningDigestPayload {
  readonly active_governing_system: string | null;
  readonly system: null | {
    readonly id: string;
    readonly version: string;
    readonly runtime_digest: string;
    readonly persistent_kernel: string;
  };
  readonly modules: readonly {
    readonly id: string;
    readonly version: string;
    readonly governed_by: string;
    readonly runtime_digest: string;
  }[];
}

interface MemoryProjectionPayload {
  readonly entries: readonly {
    readonly id: string;
    readonly layer: AuthorityRecord["layer"];
    readonly role: RegistryRole;
    readonly version: string;
    readonly content: string;
    readonly checksum: string;
  }[];
}

interface IndexMetadataPayload {
  readonly entries: readonly {
    readonly id: string;
    readonly layer: AuthorityRecord["layer"];
    readonly role: RegistryRole;
    readonly version: string;
    readonly checksum: string;
  }[];
}

interface ViewProjectionPayload {
  readonly authority_revision: string;
  readonly active_governing_system: string | null;
  readonly record_refs: readonly string[];
}

export interface ActiveGeneration {
  readonly directory: string;
  readonly manifest: GenerationManifest;
  readonly normalizedRecords: GenerationArtifact<{ readonly records: readonly NormalizedRecord[] }>;
  readonly registry: GenerationArtifact<RegistryPayload>;
  readonly governingDigest: GenerationArtifact<GoverningDigestPayload>;
  readonly memoryProjection: GenerationArtifact<MemoryProjectionPayload>;
  readonly indexMetadata: GenerationArtifact<IndexMetadataPayload>;
  readonly viewProjection: GenerationArtifact<ViewProjectionPayload>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalize = (value: unknown): JsonValue => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  throw new Error("GENERATION_VALUE_NOT_SERIALIZABLE");
};

const canonicalJson = (value: unknown): string =>
  `${JSON.stringify(canonicalize(value))}\n`;

const checksum = (value: string | Uint8Array): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const requireString = (value: unknown, reason: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(reason);
  }
  return value;
};

const requireText = (value: unknown, reason: string): string => {
  if (typeof value !== "string") {
    throw new Error(reason);
  }
  return value;
};

const requireStringArray = (value: unknown, reason: string): readonly string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(reason);
  }
  return value as readonly string[];
};

const roleFor = (record: AuthorityRecord): RegistryRole => {
  if (record.layer === "evidence" || record.layer === "semantic") {
    return record.layer;
  }
  if (record.recordType === "governing_system") {
    return "governing_system";
  }
  if (record.recordType === "governing_module") {
    return "governing_module";
  }
  return "ordinary_framework";
};

const versionFor = (record: AuthorityRecord): string => {
  const value = record.frontmatter.entity_version
    ?? record.frontmatter.updated_at
    ?? record.frontmatter.imported_at
    ?? record.frontmatter.created_at;
  if (typeof value !== "string" && typeof value !== "number") {
    if (
      isRecord(value) &&
      typeof value.value === "string" &&
      typeof value.precision === "string"
    ) {
      return `${value.precision}:${value.value}`;
    }
    throw new Error(`AUTHORITY_VERSION_REQUIRED:${record.id}`);
  }
  return String(value);
};

const normalizedRecord = (record: AuthorityRecord): NormalizedRecord => {
  const base = {
    id: record.id,
    layer: record.layer,
    role: roleFor(record),
    record_type: record.recordType,
    schema_version: record.schemaVersion,
    version: versionFor(record),
    frontmatter: record.frontmatter,
    body: record.body,
    sections: [...record.sections.entries()]
      .map(([title, content]) => ({ title, content }))
      .sort((left, right) => left.title.localeCompare(right.title)),
  };
  return { ...base, checksum: checksum(canonicalJson(base)) };
};

const authorityRecordFromNormalized = (value: unknown): AuthorityRecord => {
  if (!isRecord(value) || !isRecord(value.frontmatter) || !Array.isArray(value.sections)) {
    throw new Error("NORMALIZED_RECORD_INVALID");
  }
  const layer = requireString(value.layer, "NORMALIZED_RECORD_INVALID");
  if (!["evidence", "semantic", "cognitive"].includes(layer)) {
    throw new Error("NORMALIZED_RECORD_INVALID");
  }
  const sections = new Map<string, string>();
  for (const item of value.sections) {
    if (!isRecord(item)) {
      throw new Error("NORMALIZED_RECORD_INVALID");
    }
    const title = requireString(item.title, "NORMALIZED_RECORD_INVALID");
    if (sections.has(title)) {
      throw new Error("NORMALIZED_RECORD_INVALID");
    }
    sections.set(title, requireString(item.content, "NORMALIZED_RECORD_INVALID"));
  }
  const record: AuthorityRecord = {
    id: requireString(value.id, "NORMALIZED_RECORD_INVALID"),
    layer: layer as AuthorityRecord["layer"],
    recordType: requireString(value.record_type, "NORMALIZED_RECORD_INVALID"),
    schemaVersion: requireString(value.schema_version, "NORMALIZED_RECORD_INVALID"),
    frontmatter: value.frontmatter,
    body: requireText(value.body, "NORMALIZED_RECORD_INVALID"),
    sections,
  };
  const contract = record.schemaVersion === "cognitive-runtime.evidence/v2"
    ? "evidence"
    : record.schemaVersion === "cognitive-runtime.semantic/v2"
      ? "semantic"
      : record.schemaVersion === "cognitive-runtime.personal-model/v2"
        ? "personal-model"
        : record.schemaVersion === "cognitive-runtime.cognitive/v2"
          ? "cognitive"
          : null;
  if (contract === null || !validateContract(contract, record.frontmatter).valid) {
    throw new Error(`NORMALIZED_RECORD_CONTRACT_INVALID:${record.id}`);
  }
  const expectedId = record.frontmatter[
    record.layer === "evidence"
      ? "source_id"
      : record.layer === "cognitive"
        ? "cognitive_id"
        : "claim_id"
  ];
  if (expectedId !== record.id || !lintAuthorityRecord(record).valid) {
    throw new Error(`NORMALIZED_RECORD_AUTHORITY_INVALID:${record.id}`);
  }
  const expected = normalizedRecord(record);
  if (canonicalJson(expected) !== canonicalJson(value)) {
    throw new Error(`NORMALIZED_RECORD_DRIFT:${record.id}`);
  }
  return record;
};

const assertInside = (parent: string, child: string, reason: string): void => {
  const relative = resolve(child).slice(resolve(parent).length);
  if (relative !== "" && !relative.startsWith(sep)) {
    throw new Error(reason);
  }
};

const discoverMarkdown = async (
  directory: string,
  authorityDirectory = directory,
): Promise<readonly string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const discovered: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`AUTHORITY_SYMLINK_UNSUPPORTED:${path}`);
    }
    if (entry.isDirectory()) {
      discovered.push(...await discoverMarkdown(path, authorityDirectory));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const [layer] = relative(authorityDirectory, path).split(sep);
      if (
        (layer === "evidence" && entry.name === "source.md") ||
        (layer === "cognitive" && entry.name === "entity.md") ||
        layer === "semantic"
      ) {
        discovered.push(path);
      }
    }
  }
  return discovered;
};

const readAuthority = async (
  authorityDirectory: string,
): Promise<{
  readonly records: readonly AuthorityRecord[];
  readonly activeGoverningSystem: string | null;
}> => {
  const paths = await discoverMarkdown(authorityDirectory);
  if (paths.length === 0) {
    throw new Error("AUTHORITY_RECORDS_REQUIRED");
  }
  const records = await Promise.all(paths.map(async (path) =>
    parseAuthorityMarkdown(await readFile(path, "utf8"), { sourcePath: path })));
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id)) {
      throw new Error(`DUPLICATE_STABLE_ID:${record.id}`);
    }
    seen.add(record.id);
    const lint = lintAuthorityRecord(record);
    if (!lint.valid) {
      throw new Error(
        `AUTHORITY_LINT_FAILED:${record.id}:${lint.issues.map((issue) => issue.code).join(",")}`,
      );
    }
  }

  const bindingPath = join(authorityDirectory, "cognitive-binding.json");
  const binding = JSON.parse(await readFile(bindingPath, "utf8")) as unknown;
  const bindingValidation = validateContract("cognitive-binding", binding);
  if (!bindingValidation.valid || !isRecord(binding)) {
    throw new Error("COGNITIVE_BINDING_INVALID");
  }
  const active = binding.active_governing_system;
  if (active !== null && typeof active !== "string") {
    throw new Error("COGNITIVE_BINDING_INVALID");
  }

  validateReferences(records, active);
  return { records, activeGoverningSystem: active };
};

const resolveRefs = (
  records: readonly AuthorityRecord[],
  owner: AuthorityRecord,
  field: string,
  expectedLayer?: AuthorityRecord["layer"],
): void => {
  for (const id of requireStringArray(
    owner.frontmatter[field] ?? [],
    `AUTHORITY_REF_FIELD_INVALID:${owner.id}:${field}`,
  )) {
    resolveStableId(records, id, expectedLayer);
  }
};

const validateReferences = (
  records: readonly AuthorityRecord[],
  activeGoverningSystem: string | null,
): void => {
  for (const record of records) {
    if (record.layer === "semantic") {
      resolveRefs(records, record, "source_refs", "evidence");
      resolveRefs(records, record, "supersedes", "semantic");
      if (record.schemaVersion === "cognitive-runtime.semantic/v2") {
        resolveRefs(records, record, "related_claims", "semantic");
      } else {
        resolveRefs(records, record, "counterevidence_refs");
      }
    } else if (record.layer === "cognitive") {
      resolveRefs(records, record, "source_refs", "evidence");
      const relations = record.frontmatter.relations;
      if (!isRecord(relations)) {
        throw new Error(`COGNITIVE_RELATIONS_INVALID:${record.id}`);
      }
      for (const field of ["complements", "tensions"] as const) {
        for (const id of requireStringArray(
          relations[field],
          `COGNITIVE_RELATIONS_INVALID:${record.id}`,
        )) {
          resolveStableId(records, id, "cognitive");
        }
      }
      const parent = relations.parent;
      if (parent !== null) {
        resolveStableId(records, requireString(parent, "COGNITIVE_RELATIONS_INVALID"), "cognitive");
      }
      const governedBy = relations.governed_by;
      if (governedBy !== null) {
        const governing = resolveStableId(
          records,
          requireString(governedBy, "COGNITIVE_RELATIONS_INVALID"),
          "cognitive",
        );
        if (governing.recordType !== "governing_system") {
          throw new Error(`AUTHORITY_ROLE_MISMATCH:${governing.id}:governing_system`);
        }
      }
      if (record.recordType === "governing_module" && governedBy === null) {
        throw new Error(`AUTHORITY_ROLE_MISMATCH:${record.id}:governing_module`);
      }
    }
  }
  if (activeGoverningSystem !== null) {
    const active = resolveStableId(records, activeGoverningSystem, "cognitive");
    if (active.recordType !== "governing_system") {
      throw new Error(`AUTHORITY_ROLE_MISMATCH:${active.id}:governing_system`);
    }
  }
};

const artifact = <TPayload>(
  metadata: {
    readonly contractVersion: string;
    readonly packageVersion: string;
    readonly sourceRevision: string;
    readonly syncGeneration: string;
  },
  payload: TPayload,
): GenerationArtifact<TPayload> => ({
  contract_version: metadata.contractVersion,
  package_version: metadata.packageVersion,
  source_revision: metadata.sourceRevision,
  sync_generation: metadata.syncGeneration,
  content_checksum: checksum(canonicalJson(payload)),
  payload,
});

const writeArtifact = async (
  directory: string,
  path: string,
  value: GenerationArtifact,
  dependencies: readonly string[],
): Promise<GenerationManifestFile> => {
  const content = canonicalJson(value);
  await writeFile(join(directory, path), content, { flag: "wx" });
  return { path, checksum: checksum(content), dependencies };
};

const governingDigestPayload = (
  records: readonly NormalizedRecord[],
  activeGoverningSystem: string | null,
): GoverningDigestPayload => {
  if (activeGoverningSystem === null) {
    return { active_governing_system: null, system: null, modules: [] };
  }
  const system = records.find((record) => record.id === activeGoverningSystem);
  if (system === undefined || system.role !== "governing_system") {
    throw new Error(`AUTHORITY_ROLE_MISMATCH:${activeGoverningSystem}:governing_system`);
  }
  return {
    active_governing_system: activeGoverningSystem,
    system: {
      id: system.id,
      version: system.version,
      runtime_digest: system.sections.find((section) => section.title === "Runtime digest")?.content ?? "",
      persistent_kernel: system.sections.find((section) => section.title === "Persistent Kernel")?.content ?? "",
    },
    modules: records
      .filter((record) => record.role === "governing_module" && record.frontmatter.relations !== undefined)
      .map((record) => {
        const relations = record.frontmatter.relations;
        if (!isRecord(relations) || typeof relations.governed_by !== "string") {
          throw new Error(`AUTHORITY_ROLE_MISMATCH:${record.id}:governing_module`);
        }
        return {
          id: record.id,
          version: record.version,
          governed_by: relations.governed_by,
          runtime_digest: record.sections.find((section) => section.title === "Runtime digest")?.content ?? "",
        };
      })
      .filter((module) => module.governed_by === activeGoverningSystem)
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
};

const registryPayloadFor = (
  records: readonly NormalizedRecord[],
  syncGeneration: string,
): RegistryPayload => {
  const entries: RouterRegistryEntry[] = records.map((record) => {
    const governedBy = isRecord(record.frontmatter.relations)
      && typeof record.frontmatter.relations.governed_by === "string"
      ? record.frontmatter.relations.governed_by
      : undefined;
    return {
      id: record.id,
      role: record.role,
      version: record.version,
      syncGeneration,
      checksum: record.checksum,
      ...(governedBy === undefined ? {} : { governedBy }),
    };
  });
  return { checksum: calculateRegistryChecksum(entries), entries };
};

const memoryProjectionPayload = (
  records: readonly NormalizedRecord[],
): MemoryProjectionPayload => ({
  entries: records.map((record) => ({
    id: record.id,
    layer: record.layer,
    role: record.role,
    version: record.version,
    content: record.body,
    checksum: record.checksum,
  })),
});

const indexMetadataPayload = (
  records: readonly NormalizedRecord[],
): IndexMetadataPayload => ({
  entries: records.map((record) => ({
    id: record.id,
    layer: record.layer,
    role: record.role,
    version: record.version,
    checksum: record.checksum,
  })),
});

const viewProjectionPayload = (
  records: readonly NormalizedRecord[],
  sourceRevision: string,
  activeGoverningSystem: string | null,
): ViewProjectionPayload => ({
  authority_revision: sourceRevision,
  active_governing_system: activeGoverningSystem,
  record_refs: records.map((record) => record.id),
});

export async function buildGeneration(
  options: GenerationBuildOptions,
): Promise<GenerationBuildResult> {
  if (options.sourceRevision.trim().length === 0) {
    throw new Error("SOURCE_REVISION_REQUIRED");
  }
  if (options.packageVersion.trim().length === 0) {
    throw new Error("PACKAGE_VERSION_REQUIRED");
  }
  const authorityDirectory = resolve(options.authorityDirectory);
  const stateDirectory = resolve(options.stateDirectory);
  const authorityStat = await lstat(authorityDirectory);
  if (!authorityStat.isDirectory()) {
    throw new Error("AUTHORITY_DIRECTORY_REQUIRED");
  }
  const authority = await readAuthority(authorityDirectory);
  const records = authority.records
    .map(normalizedRecord)
    .sort((left, right) => left.id.localeCompare(right.id));
  const generationSeed = {
    contract_version: CONTRACT_VERSION,
    package_version: options.packageVersion,
    source_revision: options.sourceRevision,
    active_governing_system: authority.activeGoverningSystem,
    records,
  };
  const syncGeneration = `generation-${checksum(canonicalJson(generationSeed)).slice("sha256:".length)}`;
  const metadata = {
    contractVersion: CONTRACT_VERSION,
    packageVersion: options.packageVersion,
    sourceRevision: options.sourceRevision,
    syncGeneration,
  };
  const registryPayload = registryPayloadFor(records, syncGeneration);
  const governingPayload = governingDigestPayload(records, authority.activeGoverningSystem);
  const memoryPayload = memoryProjectionPayload(records);
  const indexPayload = indexMetadataPayload(records);
  const viewPayload = viewProjectionPayload(
    records,
    options.sourceRevision,
    authority.activeGoverningSystem,
  );

  const stagingRoot = join(stateDirectory, "staging");
  await mkdir(stagingRoot, { recursive: true });
  const stagingDirectory = await mkdtemp(join(stagingRoot, `${syncGeneration}-`));
  try {
    const files = await Promise.all([
      writeArtifact(stagingDirectory, "normalized-records.json", artifact(metadata, { records }), []),
      writeArtifact(stagingDirectory, "registry.json", artifact(metadata, registryPayload), ["normalized-records.json"]),
      writeArtifact(stagingDirectory, "governing-digest.json", artifact(metadata, governingPayload), ["normalized-records.json", "registry.json"]),
      writeArtifact(stagingDirectory, "memory-projection.json", artifact(metadata, memoryPayload), ["normalized-records.json", "registry.json"]),
      writeArtifact(stagingDirectory, "index-metadata.json", artifact(metadata, indexPayload), ["registry.json"]),
      writeArtifact(stagingDirectory, "view-projection.json", artifact(metadata, viewPayload), ["governing-digest.json", "index-metadata.json", "memory-projection.json", "registry.json"]),
    ]);
    const manifest: GenerationManifest = {
      schema_version: "cognitive-runtime.generation-manifest/v2",
      contract_version: CONTRACT_VERSION,
      package_version: options.packageVersion,
      source_revision: options.sourceRevision,
      sync_generation: syncGeneration,
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
    };
    await writeFile(join(stagingDirectory, "manifest.json"), canonicalJson(manifest), { flag: "wx" });
    const verification = await verifyGeneration(stagingDirectory);
    if (!verification.valid) {
      throw new Error(`GENERATION_BUILD_INVALID:${verification.issues.join(",")}`);
    }
    return { syncGeneration, stagingDirectory, manifest };
  } catch (error: unknown) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

const parseManifest = (value: unknown): GenerationManifest => {
  if (
    !isRecord(value) ||
    !validateContract("generation-manifest", value).valid
  ) {
    throw new Error("GENERATION_MANIFEST_INVALID");
  }
  const filesValue = value.files;
  if (!Array.isArray(filesValue)) {
    throw new Error("GENERATION_MANIFEST_INVALID");
  }
  const files = filesValue.map((item) => {
    if (!isRecord(item)) {
      throw new Error("GENERATION_MANIFEST_INVALID");
    }
    const path = requireString(item.path, "GENERATION_MANIFEST_INVALID");
    if (basename(path) !== path || path === "manifest.json") {
      throw new Error("GENERATION_MANIFEST_INVALID");
    }
    return {
      path,
      checksum: requireString(item.checksum, "GENERATION_MANIFEST_INVALID"),
      dependencies: requireStringArray(item.dependencies, "GENERATION_MANIFEST_INVALID"),
    };
  });
  return {
    schema_version: "cognitive-runtime.generation-manifest/v2",
    contract_version: requireString(value.contract_version, "GENERATION_MANIFEST_INVALID"),
    package_version: requireString(value.package_version, "GENERATION_MANIFEST_INVALID"),
    source_revision: requireString(value.source_revision, "GENERATION_MANIFEST_INVALID"),
    sync_generation: requireString(value.sync_generation, "GENERATION_MANIFEST_INVALID"),
    files,
  };
};

const parseArtifact = (value: unknown): GenerationArtifact => {
  if (!isRecord(value) || !("payload" in value)) {
    throw new Error("GENERATION_ARTIFACT_INVALID");
  }
  return {
    contract_version: requireString(value.contract_version, "GENERATION_ARTIFACT_INVALID"),
    package_version: requireString(value.package_version, "GENERATION_ARTIFACT_INVALID"),
    source_revision: requireString(value.source_revision, "GENERATION_ARTIFACT_INVALID"),
    sync_generation: requireString(value.sync_generation, "GENERATION_ARTIFACT_INVALID"),
    content_checksum: requireString(value.content_checksum, "GENERATION_ARTIFACT_INVALID"),
    payload: value.payload,
  };
};

export async function verifyGeneration(
  generationDirectory: string,
): Promise<GenerationVerificationResult> {
  const issues: string[] = [];
  let manifest: GenerationManifest | null = null;
  const artifacts = new Map<string, GenerationArtifact>();
  try {
    manifest = parseManifest(await readJson(join(generationDirectory, "manifest.json")));
    if (!GENERATION_PATTERN.test(manifest.sync_generation)) {
      issues.push("SYNC_GENERATION_INVALID");
    }
    const paths = new Set(manifest.files.map((file) => file.path));
    if (paths.size !== manifest.files.length) {
      issues.push("MANIFEST_DUPLICATE_FILE");
    }
    for (const file of manifest.files) {
      if (!CHECKSUM_PATTERN.test(file.checksum)) {
        issues.push(`FILE_CHECKSUM_INVALID:${file.path}`);
      }
      if (file.dependencies.some((dependency) => !paths.has(dependency))) {
        issues.push(`FILE_DEPENDENCY_MISSING:${file.path}`);
      }
      const path = join(generationDirectory, file.path);
      assertInside(generationDirectory, path, "GENERATION_FILE_OUTSIDE_DIRECTORY");
      const content = await readFile(path, "utf8");
      if (checksum(content) !== file.checksum) {
        issues.push(`FILE_CHECKSUM_MISMATCH:${file.path}`);
        continue;
      }
      const parsed = parseArtifact(JSON.parse(content) as unknown);
      artifacts.set(file.path, parsed);
      if (
        parsed.contract_version !== manifest.contract_version ||
        parsed.package_version !== manifest.package_version ||
        parsed.source_revision !== manifest.source_revision ||
        parsed.sync_generation !== manifest.sync_generation
      ) {
        issues.push(`MIXED_GENERATION:${file.path}`);
      }
      if (parsed.content_checksum !== checksum(canonicalJson(parsed.payload))) {
        issues.push(`CONTENT_CHECKSUM_MISMATCH:${file.path}`);
      }
    }
    const required = [
      "governing-digest.json",
      "index-metadata.json",
      "memory-projection.json",
      "normalized-records.json",
      "registry.json",
      "view-projection.json",
    ];
    for (const path of required) {
      if (!artifacts.has(path)) {
        issues.push(`GENERATION_ARTIFACT_MISSING:${path}`);
      }
    }
    const registryArtifact = artifacts.get("registry.json");
    if (registryArtifact !== undefined) {
      const payload = registryArtifact.payload;
      if (!isRecord(payload) || !Array.isArray(payload.entries)) {
        issues.push("REGISTRY_INVALID");
      } else {
        const entries = payload.entries.filter(isRecord).map((entry) => ({
          id: requireString(entry.id, "REGISTRY_INVALID"),
          role: requireString(entry.role, "REGISTRY_INVALID") as RegistryRole,
          version: requireString(entry.version, "REGISTRY_INVALID"),
          syncGeneration: requireString(entry.syncGeneration, "REGISTRY_INVALID"),
          checksum: requireString(entry.checksum, "REGISTRY_INVALID"),
          ...(entry.governedBy === undefined ? {} : {
            governedBy: requireString(entry.governedBy, "REGISTRY_INVALID"),
          }),
        }));
        if (entries.length !== payload.entries.length) {
          issues.push("REGISTRY_INVALID");
        }
        if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
          issues.push("DUPLICATE_STABLE_ID");
        }
        if (entries.some((entry) => entry.syncGeneration !== registryArtifact.sync_generation)) {
          issues.push("MIXED_GENERATION:registry-entry");
        }
        if (
          typeof payload.checksum !== "string" ||
          calculateRegistryChecksum(entries) !== payload.checksum
        ) {
          issues.push("REGISTRY_CHECKSUM_MISMATCH");
        }
      }
    }
    const normalizedArtifact = artifacts.get("normalized-records.json");
    const governingArtifact = artifacts.get("governing-digest.json");
    if (normalizedArtifact !== undefined && governingArtifact !== undefined) {
      const normalizedPayload = normalizedArtifact.payload;
      const governingPayloadValue = governingArtifact.payload;
      if (
        !isRecord(normalizedPayload) ||
        !Array.isArray(normalizedPayload.records) ||
        !isRecord(governingPayloadValue) ||
        !("active_governing_system" in governingPayloadValue)
      ) {
        issues.push("GENERATION_IDENTITY_INPUT_INVALID");
      } else {
        const normalizedRecords = normalizedPayload.records as readonly NormalizedRecord[];
        const authorityRecords = normalizedPayload.records.map(authorityRecordFromNormalized);
        const activeGoverningSystem = governingPayloadValue.active_governing_system;
        if (activeGoverningSystem !== null && typeof activeGoverningSystem !== "string") {
          issues.push("GENERATION_IDENTITY_INPUT_INVALID");
          return { valid: false, issues: [...new Set(issues)], manifest };
        }
        validateReferences(authorityRecords, activeGoverningSystem);
        const expectedGeneration = `generation-${checksum(canonicalJson({
          contract_version: manifest.contract_version,
          package_version: manifest.package_version,
          source_revision: manifest.source_revision,
          active_governing_system: activeGoverningSystem,
          records: normalizedRecords,
        })).slice("sha256:".length)}`;
        if (expectedGeneration !== manifest.sync_generation) {
          issues.push("GENERATION_IDENTITY_MISMATCH");
        }
        const expectedPayloads = new Map<string, unknown>([
          ["registry.json", registryPayloadFor(normalizedRecords, manifest.sync_generation)],
          ["governing-digest.json", governingDigestPayload(normalizedRecords, activeGoverningSystem)],
          ["memory-projection.json", memoryProjectionPayload(normalizedRecords)],
          ["index-metadata.json", indexMetadataPayload(normalizedRecords)],
          ["view-projection.json", viewProjectionPayload(
            normalizedRecords,
            manifest.source_revision,
            activeGoverningSystem,
          )],
        ]);
        for (const [path, expectedPayload] of expectedPayloads) {
          const actual = artifacts.get(path);
          if (
            actual !== undefined &&
            canonicalJson(actual.payload) !== canonicalJson(expectedPayload)
          ) {
            issues.push(`GENERATION_PROJECTION_MISMATCH:${path}`);
          }
        }
      }
    }
    const indexArtifact = artifacts.get("index-metadata.json");
    const memoryArtifact = artifacts.get("memory-projection.json");
    const viewArtifact = artifacts.get("view-projection.json");
    if (
      registryArtifact !== undefined &&
      indexArtifact !== undefined &&
      memoryArtifact !== undefined &&
      viewArtifact !== undefined
    ) {
      const registryPayloadValue = registryArtifact.payload;
      const indexPayloadValue = indexArtifact.payload;
      const memoryPayloadValue = memoryArtifact.payload;
      const viewPayloadValue = viewArtifact.payload;
      if (
        !isRecord(registryPayloadValue) || !Array.isArray(registryPayloadValue.entries) ||
        !isRecord(indexPayloadValue) || !Array.isArray(indexPayloadValue.entries) ||
        !isRecord(memoryPayloadValue) || !Array.isArray(memoryPayloadValue.entries) ||
        !isRecord(viewPayloadValue) || !Array.isArray(viewPayloadValue.record_refs)
      ) {
        issues.push("GENERATION_PROJECTION_INVALID");
      } else {
        const ids = (entries: readonly unknown[]): readonly string[] => entries
          .filter(isRecord)
          .map((entry) => typeof entry.id === "string" ? entry.id : "")
          .sort();
        const registryIds = ids(registryPayloadValue.entries);
        const viewIds = viewPayloadValue.record_refs
          .filter((id): id is string => typeof id === "string")
          .sort();
        if (
          registryIds.join("\n") !== ids(indexPayloadValue.entries).join("\n") ||
          registryIds.join("\n") !== ids(memoryPayloadValue.entries).join("\n") ||
          registryIds.join("\n") !== viewIds.join("\n")
        ) {
          issues.push("GENERATION_PROJECTION_REF_MISMATCH");
        }
      }
    }
  } catch (error: unknown) {
    issues.push(error instanceof Error ? error.message : "GENERATION_VERIFY_FAILED");
  }
  return { valid: issues.length === 0, issues: [...new Set(issues)], manifest };
}

export async function activateGeneration(options: {
  readonly stateDirectory: string;
  readonly stagingDirectory: string;
}): Promise<{ readonly syncGeneration: string; readonly directory: string }> {
  const stateDirectory = resolve(options.stateDirectory);
  const stagingDirectory = resolve(options.stagingDirectory);
  assertInside(join(stateDirectory, "staging"), stagingDirectory, "GENERATION_STAGE_OUTSIDE_STATE");
  const verification = await verifyGeneration(stagingDirectory);
  if (!verification.valid || verification.manifest === null) {
    throw new Error(`GENERATION_VERIFY_FAILED:${verification.issues.join(",")}`);
  }
  const generation = verification.manifest.sync_generation;
  const generationsDirectory = join(stateDirectory, "generations");
  const targetDirectory = join(generationsDirectory, generation);
  await mkdir(generationsDirectory, { recursive: true });
  const existing = await lstat(targetDirectory).catch(() => null);
  if (existing === null) {
    await rename(stagingDirectory, targetDirectory);
  } else {
    const targetVerification = await verifyGeneration(targetDirectory);
    if (!targetVerification.valid) {
      throw new Error(`GENERATION_TARGET_INVALID:${targetVerification.issues.join(",")}`);
    }
    await rm(stagingDirectory, { recursive: true, force: true });
  }
  const pointer = canonicalJson({ sync_generation: generation });
  const temporaryPointer = join(stateDirectory, `.active-${randomUUID()}.tmp`);
  await writeFile(temporaryPointer, pointer, { flag: "wx" });
  await rename(temporaryPointer, join(stateDirectory, "active.json"));
  return { syncGeneration: generation, directory: targetDirectory };
}

const typedArtifact = <TPayload>(artifactValue: GenerationArtifact): GenerationArtifact<TPayload> =>
  artifactValue as GenerationArtifact<TPayload>;

export async function loadActiveGeneration(
  stateDirectory: string,
): Promise<ActiveGeneration> {
  const pointer = await readJson(join(stateDirectory, "active.json"));
  if (!isRecord(pointer) || typeof pointer.sync_generation !== "string"
    || !GENERATION_PATTERN.test(pointer.sync_generation)) {
    throw new Error("ACTIVE_GENERATION_POINTER_INVALID");
  }
  const directory = join(stateDirectory, "generations", pointer.sync_generation);
  const verification = await verifyGeneration(directory);
  if (!verification.valid || verification.manifest === null) {
    throw new Error(`ACTIVE_GENERATION_INVALID:${verification.issues.join(",")}`);
  }
  const load = async (path: string): Promise<GenerationArtifact> =>
    parseArtifact(await readJson(join(directory, path)));
  return {
    directory,
    manifest: verification.manifest,
    normalizedRecords: typedArtifact<{ readonly records: readonly NormalizedRecord[] }>(await load("normalized-records.json")),
    registry: typedArtifact<RegistryPayload>(await load("registry.json")),
    governingDigest: typedArtifact<GoverningDigestPayload>(await load("governing-digest.json")),
    memoryProjection: typedArtifact<MemoryProjectionPayload>(await load("memory-projection.json")),
    indexMetadata: typedArtifact<IndexMetadataPayload>(await load("index-metadata.json")),
    viewProjection: typedArtifact<ViewProjectionPayload>(await load("view-projection.json")),
  };
}

export async function rebuildGeneration(
  options: GenerationBuildOptions,
): Promise<ActiveGeneration> {
  const built = await buildGeneration(options);
  await activateGeneration({
    stateDirectory: options.stateDirectory,
    stagingDirectory: built.stagingDirectory,
  });
  return loadActiveGeneration(options.stateDirectory);
}
