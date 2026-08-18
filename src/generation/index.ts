import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

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
const BUILDER_FORMAT_VERSION = "generation-builder/v2";
const GENERATION_PATTERN = /^generation-[a-f0-9]{64}$/;
const CHECKSUM_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SOURCE_REVISION_PATTERN = /^[a-f0-9]{40}$/;
const BOOTSTRAP_TARGETS = ["USER.md", "MEMORY.md"] as const;
const execFileAsync = promisify(execFile);
const gitReadOnlyOptions = {
  encoding: "utf8",
  env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
} as const;

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

interface GitTreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly objectId: string;
}

interface VerifiedAuthorityCheckout {
  readonly authorityDirectory: string;
  readonly sourceRevision: string;
  readonly entries: ReadonlyMap<string, GitTreeEntry>;
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
  readonly builder_format_version: typeof BUILDER_FORMAT_VERSION;
  readonly package_version: string;
  readonly source_revision: string;
  readonly sync_generation: string;
  readonly files: readonly GenerationManifestFile[];
}

export interface GenerationBuildOptions {
  readonly authorityDirectory: string;
  readonly stateDirectory: string;
  readonly generationsDirectory?: string;
  readonly sourceRevision: string;
  readonly packageVersion: string;
  readonly bootstrapTargets?: readonly BootstrapTarget[];
}

export type BootstrapTarget = typeof BOOTSTRAP_TARGETS[number];

export interface BootstrapProjectionResult {
  readonly target: BootstrapTarget;
  readonly path: string;
  readonly checksum: string;
  readonly reused: boolean;
}

export interface GenerationBuildResult {
  readonly syncGeneration: string;
  readonly generationDirectory: string;
  readonly reused: boolean;
  readonly manifest: GenerationManifest;
  readonly bootstrapProjections: readonly BootstrapProjectionResult[];
}

export interface AuthorityValidationOptions {
  readonly authorityDirectory: string;
  readonly sourceRevision: string;
}

export interface AuthorityValidationResult {
  readonly sourceRevision: string;
  readonly recordCount: number;
  readonly activeGoverningSystem: string | null;
}

export interface GenerationVerificationResult {
  readonly valid: boolean;
  readonly issues: readonly string[];
  readonly manifest: GenerationManifest | null;
  readonly manifestChecksum: string | null;
}

export interface GenerationStatus {
  readonly syncGeneration: string;
  readonly sourceRevision: string;
  readonly active: boolean;
  readonly activeGeneration: string | null;
  readonly activeSourceRevision: string | null;
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

interface ProjectionEntry {
  readonly schema_version: "cognitive-runtime.projection-entry/v2";
  readonly generation_id: string;
  readonly layer: AuthorityRecord["layer"];
  readonly stable_id: string;
  readonly authority_version: string;
  readonly role: Exclude<RegistryRole, "current_state"> | "personal_model";
  readonly checksum: string;
  readonly source_refs: readonly string[];
  readonly content: string;
}

interface ProjectionEntriesPayload {
  readonly entries: readonly ProjectionEntry[];
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
  readonly projectionEntries: GenerationArtifact<ProjectionEntriesPayload>;
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

const isAuthorityEntrypoint = (path: string): boolean => {
  const parts = path.split("/");
  const fileName = parts.at(-1);
  if (parts[0] === "evidence") {
    return fileName === "source.md" && !parts.includes("original") && !parts.includes("assets");
  }
  if (parts[0] === "semantic") {
    return fileName === "claim.md";
  }
  return parts[0] === "cognitive" && fileName === "entity.md";
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
      const relativeParts = relative(authorityDirectory, path).split(sep);
      if (relativeParts[0] === "evidence" && ["original", "assets"].includes(entry.name)) {
        continue;
      }
      discovered.push(...await discoverMarkdown(path, authorityDirectory));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const authorityPath = relative(authorityDirectory, path).split(sep).join("/");
      if (isAuthorityEntrypoint(authorityPath)) {
        discovered.push(path);
      }
    }
  }
  return discovered;
};

const discoverAuthorityMarkdown = async (
  authorityDirectory: string,
): Promise<readonly string[]> => {
  const paths: string[] = [];
  for (const layer of ["evidence", "semantic", "cognitive"] as const) {
    const directory = join(authorityDirectory, layer);
    let stat;
    try {
      stat = await lstat(directory);
    } catch (error: unknown) {
      if (isRecord(error) && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`AUTHORITY_ENTRYPOINT_DIRECTORY_INVALID:${layer}`);
    }
    paths.push(...await discoverMarkdown(directory, authorityDirectory));
  }
  return paths;
};

const readAuthority = async (
  checkout: VerifiedAuthorityCheckout,
): Promise<{
  readonly records: readonly AuthorityRecord[];
  readonly activeGoverningSystem: string | null;
}> => {
  const paths = await discoverAuthorityMarkdown(checkout.authorityDirectory);
  const workingPaths = new Set(paths.map((path) =>
    relative(checkout.authorityDirectory, path).split(sep).join("/")));
  const committedPaths = [...checkout.entries.keys()]
    .filter((path) => isAuthorityEntrypoint(path))
    .sort((left, right) => left.localeCompare(right));
  for (const path of workingPaths) {
    if (!checkout.entries.has(path)) {
      throw new Error(`AUTHORITY_ENTRYPOINT_UNCOMMITTED:${path}`);
    }
  }
  for (const path of committedPaths) {
    if (!workingPaths.has(path)) {
      throw new Error(`AUTHORITY_ENTRYPOINT_NOT_CHECKED_OUT:${path}`);
    }
  }
  if (committedPaths.length === 0) {
    throw new Error("AUTHORITY_RECORDS_REQUIRED");
  }
  const records = await Promise.all(committedPaths.map(async (path) =>
    parseAuthorityMarkdown(
      await readAuthorityBlob(checkout, path),
      { sourcePath: join(checkout.authorityDirectory, path) },
    )));
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

  if (!checkout.entries.has("cognitive-binding.json")) {
    throw new Error("AUTHORITY_ENTRYPOINT_UNCOMMITTED:cognitive-binding.json");
  }
  const binding = JSON.parse(
    await readAuthorityBlob(checkout, "cognitive-binding.json"),
  ) as unknown;
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

const readAuthorityBlob = async (
  checkout: VerifiedAuthorityCheckout,
  path: string,
): Promise<string> => {
  const entry = checkout.entries.get(path);
  if (entry === undefined || entry.type !== "blob" || entry.mode === "120000") {
    throw new Error(`AUTHORITY_ENTRYPOINT_INVALID:${path}`);
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", checkout.authorityDirectory, "cat-file", "blob", entry.objectId],
      { ...gitReadOnlyOptions, maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    throw new Error(`AUTHORITY_ENTRYPOINT_UNREADABLE:${path}`);
  }
};

const verifyAuthorityCheckout = async (
  options: AuthorityValidationOptions,
): Promise<VerifiedAuthorityCheckout> => {
  const authorityDirectory = resolve(options.authorityDirectory);
  if (!SOURCE_REVISION_PATTERN.test(options.sourceRevision)) {
    throw new Error("SOURCE_REVISION_AMBIGUOUS");
  }
  let repositoryRoot: string;
  let headRevision: string;
  let worktreeStatus: string;
  try {
    ({ stdout: repositoryRoot } = await execFileAsync(
      "git",
      ["-C", authorityDirectory, "rev-parse", "--show-toplevel"],
      gitReadOnlyOptions,
    ));
    ({ stdout: headRevision } = await execFileAsync(
      "git",
      ["-C", authorityDirectory, "rev-parse", "HEAD"],
      gitReadOnlyOptions,
    ));
    ({ stdout: worktreeStatus } = await execFileAsync(
      "git",
      ["-C", authorityDirectory, "status", "--porcelain=v1", "--untracked-files=all"],
      gitReadOnlyOptions,
    ));
  } catch {
    throw new Error("AUTHORITY_GIT_REPOSITORY_REQUIRED");
  }
  if (await realpath(repositoryRoot.trim()) !== await realpath(authorityDirectory)) {
    throw new Error("AUTHORITY_REPOSITORY_ROOT_REQUIRED");
  }
  if (headRevision.trim() !== options.sourceRevision) {
    throw new Error("SOURCE_REVISION_NOT_CHECKED_OUT");
  }
  if (worktreeStatus.length > 0) {
    throw new Error("AUTHORITY_WORKTREE_DIRTY");
  }
  let trackedFiles: string;
  try {
    ({ stdout: trackedFiles } = await execFileAsync(
      "git",
      ["-C", authorityDirectory, "ls-tree", "-r", "-z", options.sourceRevision],
      { ...gitReadOnlyOptions, maxBuffer: 64 * 1024 * 1024 },
    ));
  } catch {
    throw new Error("AUTHORITY_SOURCE_REVISION_UNREADABLE");
  }
  const entries = new Map<string, GitTreeEntry>();
  for (const rawEntry of trackedFiles.split("\0")) {
    if (rawEntry.length === 0) {
      continue;
    }
    const separator = rawEntry.indexOf("\t");
    const metadata = rawEntry.slice(0, separator).split(" ");
    const path = rawEntry.slice(separator + 1);
    const [mode, type, objectId] = metadata;
    if (separator < 0 || mode === undefined || type === undefined || objectId === undefined) {
      throw new Error("AUTHORITY_SOURCE_TREE_INVALID");
    }
    entries.set(path, { mode, type, objectId });
  }
  return {
    authorityDirectory,
    sourceRevision: options.sourceRevision,
    entries,
  };
};

export async function validateAuthoritySource(
  options: AuthorityValidationOptions,
): Promise<AuthorityValidationResult> {
  const checkout = await verifyAuthorityCheckout(options);
  const authority = await readAuthority(checkout);
  return {
    sourceRevision: options.sourceRevision,
    recordCount: authority.records.length,
    activeGoverningSystem: authority.activeGoverningSystem,
  };
}

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

const writeTextArtifact = async (
  directory: string,
  path: string,
  content: string,
  dependencies: readonly string[],
): Promise<GenerationManifestFile> => {
  const target = join(directory, path);
  assertInside(directory, target, "GENERATION_FILE_OUTSIDE_DIRECTORY");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, { flag: "wx" });
  return { path, checksum: checksum(content), dependencies };
};

const projectionDocumentPath = (entry: ProjectionEntry): string =>
  posix.join(
    "projections",
    entry.generation_id,
    entry.layer,
    entry.role,
    entry.stable_id,
    `${checksum(entry.authority_version).slice("sha256:".length)}-${entry.checksum.slice("sha256:".length)}.md`,
  );

const projectionDocument = (entry: ProjectionEntry): string => {
  const sourceRefs = entry.source_refs.length === 0
    ? "source_refs: []"
    : `source_refs:\n${entry.source_refs.map((sourceRef) => `  - ${sourceRef}`).join("\n")}`;
  return [
    "---",
    `generation_id: ${entry.generation_id}`,
    `layer: ${entry.layer}`,
    `stable_id: ${entry.stable_id}`,
    `authority_version: ${JSON.stringify(entry.authority_version)}`,
    `role: ${entry.role}`,
    `checksum: ${entry.checksum}`,
    sourceRefs,
    "---",
    entry.content,
    "",
  ].join("\n");
};

const bootstrapProjection = (
  target: BootstrapTarget,
  syncGeneration: string,
  entries: readonly ProjectionEntry[],
): string => [
  "---",
  `generation_id: ${syncGeneration}`,
  `target: ${target}`,
  "read_only: true",
  "authority: false",
  "---",
  `# ${target === "USER.md" ? "User Bootstrap Projection" : "Memory Bootstrap Projection"}`,
  "",
  "Generated from an immutable Stella Runtime Generation. Do not edit as Authority.",
  "",
  ...entries.flatMap((entry) => [
    `- ${entry.stable_id} (${entry.layer}, ${entry.role}, ${entry.authority_version})`,
    `  - bootstrap_alias: ${entry.stable_id}`,
    `  - projection: generations/${entry.generation_id}/${projectionDocumentPath(entry)}`,
    `  - checksum: ${entry.checksum}`,
  ]),
  "",
].join("\n");

const writeBootstrapProjections = async (
  stateDirectory: string,
  syncGeneration: string,
  entries: readonly ProjectionEntry[],
  requestedTargets: readonly BootstrapTarget[] = [],
): Promise<readonly BootstrapProjectionResult[]> => {
  const targets = [...new Set(requestedTargets)].sort((left, right) => left.localeCompare(right));
  const results: BootstrapProjectionResult[] = [];
  for (const target of targets) {
    if (!BOOTSTRAP_TARGETS.includes(target)) {
      throw new Error(`BOOTSTRAP_TARGET_INVALID:${target}`);
    }
    const content = bootstrapProjection(target, syncGeneration, entries);
    const path = join(stateDirectory, "bootstrap", syncGeneration, target);
    await mkdir(dirname(path), { recursive: true });
    let reused = false;
    try {
      await writeFile(path, content, { flag: "wx" });
    } catch (error: unknown) {
      if (!isRecord(error) || error.code !== "EEXIST") {
        throw error;
      }
      if (await readFile(path, "utf8") !== content) {
        throw new Error(`BOOTSTRAP_TARGET_TAMPERED:${target}`);
      }
      reused = true;
    }
    await chmod(path, 0o444);
    results.push({ target, path, checksum: checksum(content), reused });
  }
  return results;
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

const sourceRefsFor = (record: NormalizedRecord): readonly string[] => {
  const value = record.frontmatter.source_refs;
  if (value === undefined) {
    return [];
  }
  return [...requireStringArray(value, `AUTHORITY_REF_FIELD_INVALID:${record.id}:source_refs`)]
    .sort((left, right) => left.localeCompare(right));
};

const projectionRoleFor = (record: NormalizedRecord): ProjectionEntry["role"] => {
  if (record.record_type === "personal_model") {
    return "personal_model";
  }
  if (record.role === "current_state") {
    throw new Error(`CURRENT_STATE_NOT_PROJECTABLE:${record.id}`);
  }
  return record.role;
};

const projectionEntriesPayload = (
  records: readonly NormalizedRecord[],
  syncGeneration: string,
): ProjectionEntriesPayload => ({
  entries: records.map((record) => ({
    schema_version: "cognitive-runtime.projection-entry/v2",
    generation_id: syncGeneration,
    layer: record.layer,
    stable_id: record.id,
    authority_version: record.version,
    role: projectionRoleFor(record),
    checksum: record.checksum,
    source_refs: sourceRefsFor(record),
    content: record.body,
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
  if (options.packageVersion.trim().length === 0) {
    throw new Error("PACKAGE_VERSION_REQUIRED");
  }
  const checkout = await verifyAuthorityCheckout(options);
  const authorityDirectory = checkout.authorityDirectory;
  const stateDirectory = resolve(options.stateDirectory);
  const authorityStat = await lstat(authorityDirectory);
  if (!authorityStat.isDirectory()) {
    throw new Error("AUTHORITY_DIRECTORY_REQUIRED");
  }
  const authority = await readAuthority(checkout);
  const records = authority.records
    .map(normalizedRecord)
    .sort((left, right) => left.id.localeCompare(right.id));
  const generationSeed = {
    contract_set: CONTRACT_VERSION,
    builder_format_version: BUILDER_FORMAT_VERSION,
    source_revision: options.sourceRevision,
    binding: {
      schema_version: "cognitive-runtime.cognitive-binding/v2",
      active_governing_system: authority.activeGoverningSystem,
    },
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
  const projectionPayload = projectionEntriesPayload(records, syncGeneration);
  const indexPayload = indexMetadataPayload(records);
  const viewPayload = viewProjectionPayload(
    records,
    options.sourceRevision,
    authority.activeGoverningSystem,
  );

  const generationsDirectory = options.generationsDirectory === undefined
    ? join(stateDirectory, "generations")
    : resolve(options.generationsDirectory);
  const generationDirectory = join(generationsDirectory, syncGeneration);
  const existing = await lstat(generationDirectory).catch(() => null);
  if (existing !== null) {
    const verification = await verifyGeneration(generationDirectory);
    if (!verification.valid || verification.manifest === null) {
      throw new Error(`GENERATION_TARGET_INVALID:${verification.issues.join(",")}`);
    }
    const bootstrapProjections = await writeBootstrapProjections(
      stateDirectory,
      syncGeneration,
      projectionPayload.entries,
      options.bootstrapTargets,
    );
    return {
      syncGeneration,
      generationDirectory,
      reused: true,
      manifest: verification.manifest,
      bootstrapProjections,
    };
  }

  const stagingRoot = join(stateDirectory, "staging");
  await mkdir(stagingRoot, { recursive: true });
  const stagingDirectory = await mkdtemp(join(stagingRoot, `${syncGeneration}-`));
  try {
    const files = await Promise.all([
      writeArtifact(stagingDirectory, "normalized-records.json", artifact(metadata, { records }), []),
      writeArtifact(stagingDirectory, "registry.json", artifact(metadata, registryPayload), ["normalized-records.json"]),
      writeArtifact(stagingDirectory, "governing-digest.json", artifact(metadata, governingPayload), ["normalized-records.json", "registry.json"]),
      writeArtifact(stagingDirectory, "projection-entries.json", artifact(metadata, projectionPayload), ["normalized-records.json", "registry.json"]),
      writeArtifact(stagingDirectory, "index-metadata.json", artifact(metadata, indexPayload), ["registry.json"]),
      writeArtifact(stagingDirectory, "view-projection.json", artifact(metadata, viewPayload), ["governing-digest.json", "index-metadata.json", "projection-entries.json", "registry.json"]),
      ...projectionPayload.entries.map((entry) => writeTextArtifact(
        stagingDirectory,
        projectionDocumentPath(entry),
        projectionDocument(entry),
        ["projection-entries.json"],
      )),
    ]);
    const manifest: GenerationManifest = {
      schema_version: "cognitive-runtime.generation-manifest/v2",
      contract_version: CONTRACT_VERSION,
      builder_format_version: BUILDER_FORMAT_VERSION,
      package_version: options.packageVersion,
      source_revision: options.sourceRevision,
      sync_generation: syncGeneration,
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
    };
    const manifestValidation = validateContract("generation-manifest", manifest);
    if (!manifestValidation.valid) {
      throw new Error(`GENERATION_MANIFEST_INVALID:${manifestValidation.errors
        .map((error) => `${error.instancePath}:${error.keyword}:${error.message}`)
        .join(",")}`);
    }
    await writeFile(join(stagingDirectory, "manifest.json"), canonicalJson(manifest), { flag: "wx" });
    const verification = await verifyGeneration(stagingDirectory);
    if (!verification.valid) {
      throw new Error(`GENERATION_BUILD_INVALID:${verification.issues.join(",")}`);
    }
    await mkdir(generationsDirectory, { recursive: true });
    try {
      await rename(stagingDirectory, generationDirectory);
    } catch (error: unknown) {
      const targetVerification = await verifyGeneration(generationDirectory);
      if (!targetVerification.valid || targetVerification.manifest === null) {
        throw error;
      }
      await rm(stagingDirectory, { recursive: true, force: true });
      const bootstrapProjections = await writeBootstrapProjections(
        stateDirectory,
        syncGeneration,
        projectionPayload.entries,
        options.bootstrapTargets,
      );
      return {
        syncGeneration,
        generationDirectory,
        reused: true,
        manifest: targetVerification.manifest,
        bootstrapProjections,
      };
    }
    return {
      syncGeneration,
      generationDirectory,
      reused: false,
      manifest,
      bootstrapProjections: await writeBootstrapProjections(
        stateDirectory,
        syncGeneration,
        projectionPayload.entries,
        options.bootstrapTargets,
      ),
    };
  } catch (error: unknown) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

const parseManifest = (value: unknown): GenerationManifest => {
  if (!isRecord(value)) {
    throw new Error("GENERATION_MANIFEST_INVALID");
  }
  const validation = validateContract("generation-manifest", value);
  if (!validation.valid) {
    throw new Error(`GENERATION_MANIFEST_INVALID:${validation.errors
      .map((error) => `${error.instancePath}:${error.keyword}`)
      .join(",")}`);
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
    if (path === "manifest.json") {
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
    builder_format_version: requireString(
      value.builder_format_version,
      "GENERATION_MANIFEST_INVALID",
    ) as typeof BUILDER_FORMAT_VERSION,
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

const listGenerationFiles = async (
  directory: string,
  root = directory,
): Promise<readonly string[]> => {
  const files: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    const manifestPath = relative(root, path).split(sep).join("/");
    if (entry.isSymbolicLink()) {
      throw new Error(`GENERATION_FILE_INVALID:${manifestPath}`);
    }
    if (entry.isDirectory()) {
      files.push(...await listGenerationFiles(path, root));
    } else if (entry.isFile()) {
      files.push(manifestPath);
    } else {
      throw new Error(`GENERATION_FILE_INVALID:${manifestPath}`);
    }
  }
  return files;
};

export async function verifyGeneration(
  generationDirectory: string,
): Promise<GenerationVerificationResult> {
  const issues: string[] = [];
  let manifest: GenerationManifest | null = null;
  let manifestChecksum: string | null = null;
  const artifacts = new Map<string, GenerationArtifact>();
  try {
    const generationStat = await lstat(generationDirectory);
    if (!generationStat.isDirectory() || generationStat.isSymbolicLink()) {
      throw new Error("GENERATION_DIRECTORY_INVALID");
    }
    const manifestPath = join(generationDirectory, "manifest.json");
    const manifestStat = await lstat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      throw new Error("GENERATION_MANIFEST_INVALID");
    }
    const manifestBytes = await readFile(manifestPath);
    manifestChecksum = checksum(manifestBytes);
    manifest = parseManifest(JSON.parse(manifestBytes.toString("utf8")) as unknown);
    const directoryGeneration = basename(resolve(generationDirectory));
    if (
      GENERATION_PATTERN.test(directoryGeneration) &&
      manifest.sync_generation !== directoryGeneration
    ) {
      issues.push("GENERATION_DIRECTORY_MISMATCH");
    }
    const expectedFiles = new Set(["manifest.json", ...manifest.files.map((file) => file.path)]);
    for (const path of await listGenerationFiles(generationDirectory)) {
      if (!expectedFiles.delete(path)) {
        issues.push(`GENERATION_UNMANIFESTED_FILE:${path}`);
      }
    }
    for (const path of expectedFiles) {
      if (path !== "manifest.json") {
        issues.push(`GENERATION_ARTIFACT_MISSING:${path}`);
      }
    }
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
      const fileStat = await lstat(path);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        issues.push(`GENERATION_FILE_INVALID:${file.path}`);
        continue;
      }
      const content = await readFile(path, "utf8");
      if (checksum(content) !== file.checksum) {
        issues.push(`FILE_CHECKSUM_MISMATCH:${file.path}`);
        continue;
      }
      if (!file.path.endsWith(".json")) {
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
      "normalized-records.json",
      "projection-entries.json",
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
          return { valid: false, issues: [...new Set(issues)], manifest, manifestChecksum };
        }
        validateReferences(authorityRecords, activeGoverningSystem);
        const expectedGeneration = `generation-${checksum(canonicalJson({
          contract_set: manifest.contract_version,
          builder_format_version: manifest.builder_format_version,
          source_revision: manifest.source_revision,
          binding: {
            schema_version: "cognitive-runtime.cognitive-binding/v2",
            active_governing_system: activeGoverningSystem,
          },
          records: normalizedRecords,
        })).slice("sha256:".length)}`;
        if (expectedGeneration !== manifest.sync_generation) {
          issues.push("GENERATION_IDENTITY_MISMATCH");
        }
        const expectedPayloads = new Map<string, unknown>([
          ["registry.json", registryPayloadFor(normalizedRecords, manifest.sync_generation)],
          ["governing-digest.json", governingDigestPayload(normalizedRecords, activeGoverningSystem)],
          ["projection-entries.json", projectionEntriesPayload(
            normalizedRecords,
            manifest.sync_generation,
          )],
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
    const projectionArtifact = artifacts.get("projection-entries.json");
    const viewArtifact = artifacts.get("view-projection.json");
    if (
      registryArtifact !== undefined &&
      indexArtifact !== undefined &&
      projectionArtifact !== undefined &&
      viewArtifact !== undefined
    ) {
      const registryPayloadValue = registryArtifact.payload;
      const indexPayloadValue = indexArtifact.payload;
      const projectionPayloadValue = projectionArtifact.payload;
      const viewPayloadValue = viewArtifact.payload;
      if (
        !isRecord(registryPayloadValue) || !Array.isArray(registryPayloadValue.entries) ||
        !isRecord(indexPayloadValue) || !Array.isArray(indexPayloadValue.entries) ||
        !isRecord(projectionPayloadValue) || !Array.isArray(projectionPayloadValue.entries) ||
        !isRecord(viewPayloadValue) || !Array.isArray(viewPayloadValue.record_refs)
      ) {
        issues.push("GENERATION_PROJECTION_INVALID");
      } else {
        const ids = (entries: readonly unknown[], key = "id"): readonly string[] => entries
          .filter(isRecord)
          .map((entry) => typeof entry[key] === "string" ? entry[key] : "")
          .sort();
        const registryIds = ids(registryPayloadValue.entries);
        const viewIds = viewPayloadValue.record_refs
          .filter((id): id is string => typeof id === "string")
          .sort();
        if (
          registryIds.join("\n") !== ids(indexPayloadValue.entries).join("\n") ||
          registryIds.join("\n") !== ids(projectionPayloadValue.entries, "stable_id").join("\n") ||
          registryIds.join("\n") !== viewIds.join("\n")
        ) {
          issues.push("GENERATION_PROJECTION_REF_MISMATCH");
        }
      }
    }
    if (projectionArtifact !== undefined && isRecord(projectionArtifact.payload)
      && Array.isArray(projectionArtifact.payload.entries)) {
      for (const value of projectionArtifact.payload.entries) {
        if (!isRecord(value) || !validateContract("projection-entry", value).valid) {
          issues.push("PROJECTION_ENTRY_INVALID");
          continue;
        }
        const entry = value as unknown as ProjectionEntry;
        const path = projectionDocumentPath(entry);
        const manifestFile = manifest.files.find((file) => file.path === path);
        if (manifestFile === undefined) {
          issues.push(`PROJECTION_DOCUMENT_MISSING:${entry.stable_id}`);
          continue;
        }
        const content = await readFile(join(generationDirectory, path), "utf8");
        if (content !== projectionDocument(entry)) {
          issues.push(`PROJECTION_DOCUMENT_MISMATCH:${entry.stable_id}`);
        }
      }
    }
  } catch (error: unknown) {
    issues.push(error instanceof Error ? error.message : "GENERATION_VERIFY_FAILED");
  }
  return {
    valid: issues.length === 0,
    issues: [...new Set(issues)],
    manifest,
    manifestChecksum,
  };
}

export async function activateGeneration(options: {
  readonly stateDirectory: string;
  readonly stagingDirectory: string;
}): Promise<{ readonly syncGeneration: string; readonly directory: string }> {
  const stateDirectory = resolve(options.stateDirectory);
  const stagingDirectory = resolve(options.stagingDirectory);
  const staged = relative(join(stateDirectory, "staging"), stagingDirectory);
  const built = relative(join(stateDirectory, "generations"), stagingDirectory);
  const isStaged = staged !== "" && !staged.startsWith("..") && !staged.startsWith(sep);
  const isBuilt = built !== "" && !built.startsWith("..") && !built.startsWith(sep);
  if (!isStaged && !isBuilt) {
    throw new Error("GENERATION_STAGE_OUTSIDE_STATE");
  }
  const verification = await verifyGeneration(stagingDirectory);
  if (!verification.valid || verification.manifest === null) {
    throw new Error(`GENERATION_VERIFY_FAILED:${verification.issues.join(",")}`);
  }
  const generation = verification.manifest.sync_generation;
  const generationsDirectory = join(stateDirectory, "generations");
  const targetDirectory = join(generationsDirectory, generation);
  await mkdir(generationsDirectory, { recursive: true });
  const existing = await lstat(targetDirectory).catch(() => null);
  if (existing === null && isStaged) {
    await rename(stagingDirectory, targetDirectory);
  } else if (stagingDirectory !== targetDirectory) {
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
    projectionEntries: typedArtifact<ProjectionEntriesPayload>(await load("projection-entries.json")),
    indexMetadata: typedArtifact<IndexMetadataPayload>(await load("index-metadata.json")),
    viewProjection: typedArtifact<ViewProjectionPayload>(await load("view-projection.json")),
  };
}

export async function showGeneration(options: {
  readonly stateDirectory: string;
  readonly syncGeneration: string;
}): Promise<GenerationStatus> {
  if (!GENERATION_PATTERN.test(options.syncGeneration)) {
    throw new Error("SYNC_GENERATION_INVALID");
  }
  const targetDirectory = join(
    resolve(options.stateDirectory),
    "generations",
    options.syncGeneration,
  );
  const target = await verifyGeneration(targetDirectory);
  if (!target.valid || target.manifest === null) {
    throw new Error(`GENERATION_TARGET_INVALID:${target.issues.join(",")}`);
  }
  let activeGeneration: ActiveGeneration | null = null;
  try {
    activeGeneration = await loadActiveGeneration(options.stateDirectory);
  } catch (error: unknown) {
    if (!isRecord(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  return {
    syncGeneration: target.manifest.sync_generation,
    sourceRevision: target.manifest.source_revision,
    active: activeGeneration?.manifest.sync_generation === target.manifest.sync_generation,
    activeGeneration: activeGeneration?.manifest.sync_generation ?? null,
    activeSourceRevision: activeGeneration?.manifest.source_revision ?? null,
  };
}

export async function rebuildGeneration(
  options: GenerationBuildOptions,
): Promise<ActiveGeneration> {
  const built = await buildGeneration(options);
  await activateGeneration({
    stateDirectory: options.stateDirectory,
    stagingDirectory: built.generationDirectory,
  });
  return loadActiveGeneration(options.stateDirectory);
}
