import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { validateContract } from "../contracts/index.js";
import { atomicWriteFile } from "../core/persistence.js";
import type { PersonalDataLayout } from "./index.js";
import { jcsCanonicalJson } from "./canonical.js";
import {
  runProjectionConsumerConformance,
  assertRuntimeIdentityContextPolicy,
  type ConsumedProjection,
  type ProjectionConsumptionPurpose,
  type ProjectionManifest,
  type ProjectionPublication,
  type RuntimeIdentityProjectionPublication,
} from "./projection.js";

export type ProjectionPublishFailpoint =
  | "before_payload_write"
  | "after_temporary_revision_complete"
  | "after_revision_rename"
  | "after_active_replace"
  | "before_lock_release";

export type ProjectionOwnerStatus = "alive" | "dead" | "unknown";

export interface ProjectionLockOwner {
  readonly id: string;
  readonly pid: number;
  readonly hostname: string;
  readonly started_at: string;
  readonly lease_expires_at: string;
}

export interface FileProjectionExchangeOptions {
  readonly layout: PersonalDataLayout;
  readonly instanceId: string;
  readonly ownerId: string;
  readonly now?: () => string;
  readonly leaseDurationMs?: number;
  readonly failpoint?: (point: ProjectionPublishFailpoint) => void | Promise<void>;
  readonly ownerStatus?: (
    owner: ProjectionLockOwner,
  ) => ProjectionOwnerStatus | Promise<ProjectionOwnerStatus>;
}

export interface ProjectionPublishResult {
  readonly outcome: "published" | "reused";
  readonly projectionRevision: string;
  readonly sourceRevision: string;
  readonly manifestChecksum: string;
}

export interface CollectOrphanRevisionsOptions {
  readonly gracePeriodMs: number;
}

export interface ProjectionCollectionResult {
  readonly removedRevisions: readonly string[];
  readonly protectedRevisions: string[];
  readonly gracePeriodRevisions: readonly string[];
}

export type ProjectionLockPhase =
  | "acquired"
  | "temporary_revision_complete"
  | "revision_committed"
  | "active_committed";

export interface ProjectionRecoveryResult {
  readonly outcome: "clean" | "recovered" | "rolled_back" | "degraded";
  readonly phase: ProjectionLockPhase | null;
  readonly ownerId: string | null;
  readonly projectionRevision: string | null;
  readonly reasonCode: string;
}

interface ProjectionLockRecordBase {
  readonly schema_version: "stella.projection-publish-lock/v1";
  readonly instance_id: string;
  readonly owner: ProjectionLockOwner;
}

interface ProjectionCollectionLockRecord extends ProjectionLockRecordBase {
  readonly operation: "collect";
  readonly phase: "acquired";
}

interface ProjectionPublishLockRecord extends ProjectionLockRecordBase {
  readonly operation: "publish";
  readonly phase: ProjectionLockPhase;
  readonly target: {
    readonly projection_revision: string;
    readonly source_revision: string;
    readonly as_of: string;
    readonly manifest_checksum: string;
    readonly existing_revision: boolean;
    readonly temporary_directory: string;
    readonly pointer: Readonly<Record<string, unknown>>;
  };
}

type ProjectionLockRecord = ProjectionCollectionLockRecord | ProjectionPublishLockRecord;

interface VerifiedRevision {
  readonly manifest: ProjectionManifest;
  readonly manifestChecksum: string;
}

interface ProjectionSourceBinding {
  readonly schema_version: "stella.projection-source-binding/v1";
  readonly instance_id: string;
  readonly source_revision: string;
  readonly source_as_of: string;
  readonly projection_revision: string;
}

const LOCK_DIRECTORY = ".publish-lock";
const LOCK_RECORD = "owner.json";
const RUNTIME_METADATA_DIRECTORY = ".runtime";
const SOURCE_BINDINGS_DIRECTORY = "source-bindings";
const RETENTION_FILE = "last-verified.json";
const MAX_POINTER_BYTES = 64 * 1024;
const MAX_PROJECTION_FILE_BYTES = 1024 * 1024;
const POINTER_RETRY_LIMIT = 3;

const checksum = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorCode = (error: unknown): unknown =>
  isRecord(error) ? error.code : undefined;

const syncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const assertContainedPath = (root: string, path: string): void => {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error("PROJECTION_PATH_ESCAPE");
  }
};

const assertRelativeProjectionPath = (path: string): void => {
  if (
    path.length === 0
    || path.includes("\\")
    || resolve("/projection", path) === "/projection"
    || !resolve("/projection", path).startsWith(`/projection${sep}`)
  ) {
    throw new Error("PROJECTION_PAYLOAD_PATH_ESCAPE");
  }
};

const pointerFor = (
  manifest: ProjectionManifest,
  manifestChecksum: string,
  changedAt: string,
): Readonly<Record<string, unknown>> => {
  const values = {
    schema_version: "stella.context-projection-pointer/v1",
    instance_id: manifest.instance_id,
    producer_id: manifest.producer_id,
    consumer_id: manifest.consumer_id,
    status: "active",
    projection_revision: manifest.projection_revision,
    manifest_checksum: manifestChecksum,
    source_revision: manifest.source.revision,
    as_of: manifest.source.as_of,
    changed_at: changedAt,
  } as const;
  return {
    ...values,
    pointer_revision: `pointer-${createHash("sha256")
      .update(jcsCanonicalJson(values))
      .digest("hex")}`,
  };
};

const writeSyncedFile = async (path: string, bytes: Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
};

const readSecureFile = async (
  root: string,
  path: string,
  maximumBytes: number,
): Promise<Buffer> => {
  assertContainedPath(root, path);
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw new Error("PROJECTION_SYMLINK_FORBIDDEN");
  if (!metadata.isFile()) throw new Error("PROJECTION_NON_REGULAR_FILE");
  if (metadata.nlink !== 1) throw new Error("PROJECTION_HARDLINK_FORBIDDEN");
  if (metadata.size > maximumBytes) throw new Error("PROJECTION_FILE_OVERSIZE");
  const canonicalRoot = await realpath(root);
  const canonicalPath = await realpath(path);
  if (!canonicalPath.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error("PROJECTION_PATH_ESCAPE");
  }
  return readFile(path);
};

const expectedDirectories = (files: ReadonlySet<string>): ReadonlySet<string> => {
  const result = new Set<string>();
  for (const file of files) {
    let parent = dirname(file);
    while (parent !== ".") {
      result.add(parent);
      parent = dirname(parent);
    }
  }
  return result;
};

const assertRevisionTree = async (
  revisionRoot: string,
  manifest: ProjectionManifest,
): Promise<void> => {
  const allowedFiles = new Set([
    "manifest.json",
    ...manifest.payloads.map(({ path }) => path),
  ]);
  const allowedDirectories = expectedDirectories(allowedFiles);
  const foundFiles = new Set<string>();
  const canonicalRevisionRoot = await realpath(revisionRoot);
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory);
    for (const name of entries) {
      const path = join(directory, name);
      const child = relative(revisionRoot, path).split(sep).join("/");
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error("PROJECTION_SYMLINK_FORBIDDEN");
      if (metadata.isDirectory()) {
        if (!allowedDirectories.has(child)) throw new Error("PROJECTION_UNKNOWN_FILE");
        const canonicalDirectory = await realpath(path);
        if (!canonicalDirectory.startsWith(`${canonicalRevisionRoot}${sep}`)) {
          throw new Error("PROJECTION_PATH_ESCAPE");
        }
        await visit(path);
      } else if (metadata.isFile()) {
        if (!allowedFiles.has(child)) throw new Error("PROJECTION_UNKNOWN_FILE");
        if (metadata.nlink !== 1) throw new Error("PROJECTION_HARDLINK_FORBIDDEN");
        if (metadata.size > MAX_PROJECTION_FILE_BYTES) {
          throw new Error("PROJECTION_FILE_OVERSIZE");
        }
        if (foundFiles.has(child)) throw new Error("PROJECTION_DUPLICATE_FILE");
        foundFiles.add(child);
      } else {
        throw new Error("PROJECTION_NON_REGULAR_FILE");
      }
    }
  };
  await visit(revisionRoot);
  if (foundFiles.size !== allowedFiles.size) throw new Error("PROJECTION_FILE_MISSING");
};

const parseManifest = (bytes: Uint8Array): ProjectionManifest => {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    throw new Error("PROJECTION_MANIFEST_JSON_INVALID");
  }
  if (!validateContract("context-projection-manifest", value).valid) {
    throw new Error("PROJECTION_MANIFEST_INVALID");
  }
  return value as ProjectionManifest;
};

const assertRuntimeIdentityPayload = (
  publication: RuntimeIdentityProjectionPublication,
): void => {
  if (
    publication.payloads.length !== 1
    || publication.payloads[0]?.path !== "payloads/identity-context.json"
    || publication.payloads[0].mediaType !== "application/json"
  ) {
    throw new Error("IDENTITY_CONTEXT_PAYLOAD_INVALID");
  }
  let value: unknown;
  try {
    value = JSON.parse(publication.payloads[0].bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("IDENTITY_CONTEXT_PAYLOAD_INVALID");
  }
  if (!validateContract("identity-context", value).valid || !isRecord(value)) {
    throw new Error("IDENTITY_CONTEXT_PAYLOAD_INVALID");
  }
  assertRuntimeIdentityContextPolicy(
    value,
    publication.manifest.source_references,
    publication.sourcePolicies,
  );
};

const verifyRevision = async (
  revisionRoot: string,
  instanceId: string,
  producerId: "stella-runtime" | "stella-fitness",
  consumerId: "stella-fitness" | "stella-runtime",
): Promise<VerifiedRevision> => {
  const manifestBytes = await readSecureFile(
    revisionRoot,
    join(revisionRoot, "manifest.json"),
    MAX_PROJECTION_FILE_BYTES,
  );
  const manifest = parseManifest(manifestBytes);
  await assertRevisionTree(revisionRoot, manifest);
  const manifestChecksum = checksum(manifestBytes);
  const pointer = Buffer.from(jcsCanonicalJson(pointerFor(
    manifest,
    manifestChecksum,
    manifest.generated_at,
  )), "utf8");
  await runProjectionConsumerConformance({
    instanceId,
    producerId,
    consumerId,
    purpose: producerId === "stella-runtime" ? "identity_background" : "fitness_history",
    port: {
      readPointer: async () => pointer,
      readManifest: async () => manifestBytes,
      readPayload: (_revision, path) => readSecureFile(
        revisionRoot,
        join(revisionRoot, path),
        MAX_PROJECTION_FILE_BYTES,
      ),
    },
  });
  return { manifest, manifestChecksum };
};

const parseLockRecord = (value: unknown): ProjectionLockRecord => {
  if (
    !isRecord(value)
    || value.schema_version !== "stella.projection-publish-lock/v1"
    || (value.operation !== "collect" && value.operation !== "publish")
    || typeof value.instance_id !== "string"
    || !isRecord(value.owner)
    || typeof value.owner.id !== "string"
    || typeof value.owner.pid !== "number"
    || typeof value.owner.hostname !== "string"
    || typeof value.owner.started_at !== "string"
    || typeof value.owner.lease_expires_at !== "string"
  ) {
    throw new Error("PROJECTION_LOCK_RECORD_INVALID");
  }
  if (value.operation === "collect") {
    if (value.phase !== "acquired" || "target" in value) {
      throw new Error("PROJECTION_LOCK_RECORD_INVALID");
    }
    return value as unknown as ProjectionCollectionLockRecord;
  }
  if (
    !["acquired", "temporary_revision_complete", "revision_committed", "active_committed"]
      .includes(String(value.phase))
    || !isRecord(value.target)
    || typeof value.target.projection_revision !== "string"
    || typeof value.target.source_revision !== "string"
    || typeof value.target.as_of !== "string"
    || typeof value.target.manifest_checksum !== "string"
    || typeof value.target.existing_revision !== "boolean"
    || typeof value.target.temporary_directory !== "string"
    || !isRecord(value.target.pointer)
  ) {
    throw new Error("PROJECTION_LOCK_RECORD_INVALID");
  }
  return value as unknown as ProjectionLockRecord;
};

const defaultOwnerStatus = (owner: ProjectionLockOwner): ProjectionOwnerStatus => {
  if (owner.hostname !== hostname()) return "unknown";
  try {
    process.kill(owner.pid, 0);
    return "alive";
  } catch (error: unknown) {
    return errorCode(error) === "ESRCH" ? "dead" : "unknown";
  }
};

export class FileProjectionExchange {
  readonly #layout: PersonalDataLayout;
  readonly #instanceId: string;
  readonly #ownerId: string;
  readonly #now: () => string;
  readonly #leaseDurationMs: number;
  readonly #failpoint: (point: ProjectionPublishFailpoint) => void | Promise<void>;
  readonly #ownerStatus: (
    owner: ProjectionLockOwner,
  ) => ProjectionOwnerStatus | Promise<ProjectionOwnerStatus>;

  constructor(options: FileProjectionExchangeOptions) {
    if (options.layout.locator.instance_id !== options.instanceId) {
      throw new Error("PROJECTION_EXCHANGE_INSTANCE_MISMATCH");
    }
    const repository = options.layout.locator.personal_data_repository;
    const expectedStellaRoot = join(repository, "stella");
    if (
      options.layout.repository !== repository
      || options.layout.stellaRoot !== expectedStellaRoot
      || options.layout.authority !== join(expectedStellaRoot, "authority")
      || options.layout.authorityRelativeRoot !== "stella/authority"
      || options.layout.fitness !== join(expectedStellaRoot, "fitness")
      || options.layout.projections.fitness
        !== join(expectedStellaRoot, "projections", "fitness")
      || options.layout.projections.stella
        !== join(expectedStellaRoot, "projections", "stella")
    ) {
      throw new Error("PROJECTION_EXCHANGE_LOCATOR_MISMATCH");
    }
    this.#layout = options.layout;
    this.#instanceId = options.instanceId;
    this.#ownerId = options.ownerId;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#leaseDurationMs = options.leaseDurationMs ?? 5 * 60 * 1000;
    this.#failpoint = options.failpoint ?? (() => undefined);
    this.#ownerStatus = options.ownerStatus ?? defaultOwnerStatus;
  }

  async #runtimeMetadataDirectory(): Promise<string> {
    const directory = join(
      this.#layout.projections.fitness,
      RUNTIME_METADATA_DIRECTORY,
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    return directory;
  }

  async #claimSourceBinding(publication: ProjectionPublication): Promise<void> {
    const metadataDirectory = await this.#runtimeMetadataDirectory();
    const bindingsDirectory = join(metadataDirectory, SOURCE_BINDINGS_DIRECTORY);
    await mkdir(bindingsDirectory, { recursive: true, mode: 0o700 });
    await chmod(bindingsDirectory, 0o700);
    const binding: ProjectionSourceBinding = {
      schema_version: "stella.projection-source-binding/v1",
      instance_id: this.#instanceId,
      source_revision: publication.manifest.source.revision,
      source_as_of: publication.manifest.source.as_of,
      projection_revision: publication.projectionRevision,
    };
    const bindingName = createHash("sha256")
      .update(publication.manifest.source.revision)
      .digest("hex");
    const bindingPath = join(bindingsDirectory, `${bindingName}.json`);
    let existing: unknown = null;
    try {
      const bytes = await readSecureFile(
        bindingsDirectory,
        bindingPath,
        MAX_POINTER_BYTES,
      );
      existing = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (existing !== null) {
      if (jcsCanonicalJson(existing) !== jcsCanonicalJson(binding)) {
        throw new Error("PROJECTION_SOURCE_NONDETERMINISTIC");
      }
      return;
    }

    const revisions = join(this.#layout.projections.fitness, "revisions");
    for (const revision of await readdir(revisions)) {
      if (!/^projection-[a-f0-9]{64}$/u.test(revision)) continue;
      const verified = await verifyRevision(
        join(revisions, revision),
        this.#instanceId,
        "stella-runtime",
        "stella-fitness",
      );
      if (
        verified.manifest.source.revision === binding.source_revision
        && (
          verified.manifest.source.as_of !== binding.source_as_of
          || verified.manifest.projection_revision !== binding.projection_revision
        )
      ) {
        throw new Error("PROJECTION_SOURCE_NONDETERMINISTIC");
      }
    }
    await atomicWriteFile(bindingPath, jcsCanonicalJson(binding));
  }

  async #writeLock(record: ProjectionLockRecord): Promise<void> {
    await atomicWriteFile(
      join(this.#layout.projections.fitness, LOCK_DIRECTORY, LOCK_RECORD),
      jcsCanonicalJson(record),
    );
  }

  async #acquireLock(
    publication: ProjectionPublication,
  ): Promise<ProjectionPublishLockRecord> {
    const root = this.#layout.projections.fitness;
    const lockDirectory = join(root, LOCK_DIRECTORY);
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
    } catch (error: unknown) {
      if (errorCode(error) === "EEXIST") throw new Error("PROJECTION_PUBLISH_LOCKED");
      throw error;
    }
    const startedAt = this.#now();
    const leaseExpiresAt = new Date(
      Date.parse(startedAt) + this.#leaseDurationMs,
    ).toISOString();
    const temporaryDirectory = `.tmp-${this.#ownerId}-${randomUUID()}`;
    const pointer = pointerFor(publication.manifest, publication.manifestChecksum, startedAt);
    const targetRevision = join(
      root,
      "revisions",
      publication.projectionRevision,
    );
    let existingRevision = false;
    try {
      await lstat(targetRevision);
      existingRevision = true;
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    const record: ProjectionPublishLockRecord = {
      schema_version: "stella.projection-publish-lock/v1",
      operation: "publish",
      instance_id: this.#instanceId,
      owner: {
        id: this.#ownerId,
        pid: process.pid,
        hostname: hostname(),
        started_at: startedAt,
        lease_expires_at: leaseExpiresAt,
      },
      phase: "acquired",
      target: {
        projection_revision: publication.projectionRevision,
        source_revision: publication.manifest.source.revision,
        as_of: publication.manifest.source.as_of,
        manifest_checksum: publication.manifestChecksum,
        existing_revision: existingRevision,
        temporary_directory: temporaryDirectory,
        pointer,
      },
    };
    try {
      await this.#writeLock(record);
      await syncDirectory(root);
      return record;
    } catch (error: unknown) {
      await rm(lockDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  async #acquireCollectionLock(): Promise<ProjectionCollectionLockRecord> {
    const root = this.#layout.projections.fitness;
    const lockDirectory = join(root, LOCK_DIRECTORY);
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
    } catch (error: unknown) {
      if (errorCode(error) === "EEXIST") throw new Error("PROJECTION_PUBLISH_LOCKED");
      throw error;
    }
    const startedAt = this.#now();
    const record: ProjectionCollectionLockRecord = {
      schema_version: "stella.projection-publish-lock/v1",
      operation: "collect",
      instance_id: this.#instanceId,
      owner: {
        id: this.#ownerId,
        pid: process.pid,
        hostname: hostname(),
        started_at: startedAt,
        lease_expires_at: new Date(
          Date.parse(startedAt) + this.#leaseDurationMs,
        ).toISOString(),
      },
      phase: "acquired",
    };
    try {
      await this.#writeLock(record);
      await syncDirectory(root);
      return record;
    } catch (error: unknown) {
      await rm(lockDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  async #commitRevision(
    record: ProjectionPublishLockRecord,
    temporary: string,
  ): Promise<{ readonly verified: VerifiedRevision; readonly reused: boolean }> {
    const revisions = join(this.#layout.projections.fitness, "revisions");
    const target = join(revisions, record.target.projection_revision);
    let reused = false;
    try {
      await rename(temporary, target);
      await syncDirectory(revisions);
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST" && errorCode(error) !== "ENOTEMPTY") throw error;
      reused = true;
      await rm(temporary, { recursive: true, force: true });
    }
    const verified = await verifyRevision(
      target,
      this.#instanceId,
      "stella-runtime",
      "stella-fitness",
    );
    this.#assertVerifiedTarget(record, verified);
    return { verified, reused };
  }

  #assertVerifiedTarget(
    record: ProjectionPublishLockRecord,
    verified: VerifiedRevision,
  ): void {
    if (
      verified.manifest.projection_revision !== record.target.projection_revision
      || verified.manifest.source.revision !== record.target.source_revision
      || verified.manifest.source.as_of !== record.target.as_of
      || (!record.target.existing_revision
        && verified.manifestChecksum !== record.target.manifest_checksum)
    ) {
      throw new Error("PROJECTION_EXISTING_REVISION_MISMATCH");
    }
  }

  async publishIdentityProjection(
    publication: RuntimeIdentityProjectionPublication,
  ): Promise<ProjectionPublishResult> {
    if (
      publication.manifest.instance_id !== this.#instanceId
      || publication.manifest.producer_id !== "stella-runtime"
      || publication.manifest.consumer_id !== "stella-fitness"
      || publication.manifest.projection_revision !== publication.projectionRevision
      || checksum(publication.manifestBytes) !== publication.manifestChecksum
    ) {
      throw new Error("PROJECTION_PUBLICATION_IDENTITY_MISMATCH");
    }
    assertRuntimeIdentityPayload(publication);
    const root = this.#layout.projections.fitness;
    const revisions = join(root, "revisions");
    await mkdir(revisions, { recursive: true, mode: 0o700 });
    await chmod(revisions, 0o700);
    let record = await this.#acquireLock(publication);
    const temporary = join(revisions, record.target.temporary_directory);
    assertContainedPath(revisions, temporary);
    await this.#failpoint("before_payload_write");
    await mkdir(temporary, { mode: 0o700 });
    await writeSyncedFile(join(temporary, "manifest.json"), publication.manifestBytes);
    for (const payload of publication.payloads) {
      assertRelativeProjectionPath(payload.path);
      await writeSyncedFile(join(temporary, payload.path), payload.bytes);
    }
    await syncDirectory(temporary);
    await verifyRevision(temporary, this.#instanceId, "stella-runtime", "stella-fitness");
    await this.#claimSourceBinding(publication);
    record = { ...record, phase: "temporary_revision_complete" };
    await this.#writeLock(record);
    await this.#failpoint("after_temporary_revision_complete");

    const committed = await this.#commitRevision(record, temporary);
    await this.#failpoint("after_revision_rename");
    const pointer = pointerFor(
      committed.verified.manifest,
      committed.verified.manifestChecksum,
      record.owner.started_at,
    );
    record = {
      ...record,
      phase: "revision_committed",
      target: {
        ...record.target,
        manifest_checksum: committed.verified.manifestChecksum,
        pointer,
      },
    };
    await this.#writeLock(record);

    await atomicWriteFile(join(root, "active.json"), jcsCanonicalJson(pointer));
    await this.#failpoint("after_active_replace");
    record = { ...record, phase: "active_committed" };
    await this.#writeLock(record);
    await this.#failpoint("before_lock_release");
    await rm(join(root, LOCK_DIRECTORY), { recursive: true });
    await syncDirectory(root);
    return {
      outcome: committed.reused ? "reused" : "published",
      projectionRevision: publication.projectionRevision,
      sourceRevision: publication.manifest.source.revision,
      manifestChecksum: committed.verified.manifestChecksum,
    };
  }

  async #readLock(): Promise<ProjectionLockRecord | null> {
    const root = this.#layout.projections.fitness;
    const lockDirectory = join(root, LOCK_DIRECTORY);
    try {
      const metadata = await lstat(lockDirectory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error("PROJECTION_LOCK_UNSAFE");
      }
      const bytes = await readSecureFile(
        lockDirectory,
        join(lockDirectory, LOCK_RECORD),
        MAX_POINTER_BYTES,
      );
      return parseLockRecord(JSON.parse(bytes.toString("utf8")) as unknown);
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  async recoverPublication(): Promise<ProjectionRecoveryResult> {
    let record: ProjectionLockRecord | null;
    try {
      record = await this.#readLock();
    } catch {
      return {
        outcome: "degraded", phase: null, ownerId: null, projectionRevision: null,
        reasonCode: "PROJECTION_LOCK_UNCERTAIN",
      };
    }
    if (record === null) {
      return {
        outcome: "clean", phase: null, ownerId: null, projectionRevision: null,
        reasonCode: "PROJECTION_NO_RECOVERY_REQUIRED",
      };
    }
    const diagnostic = {
      phase: record.phase,
      ownerId: record.owner.id,
      projectionRevision: record.operation === "publish"
        ? record.target.projection_revision
        : null,
    } as const;
    if (record.instance_id !== this.#instanceId) {
      return { outcome: "degraded", ...diagnostic, reasonCode: "PROJECTION_LOCK_INSTANCE_MISMATCH" };
    }
    const recoveryTime = Date.parse(this.#now());
    const leaseExpiry = Date.parse(record.owner.lease_expires_at);
    if (!Number.isFinite(recoveryTime) || !Number.isFinite(leaseExpiry)) {
      return { outcome: "degraded", ...diagnostic, reasonCode: "PROJECTION_LEASE_INVALID" };
    }
    if (recoveryTime <= leaseExpiry) {
      return { outcome: "degraded", ...diagnostic, reasonCode: "PROJECTION_LEASE_ACTIVE" };
    }
    const ownerStatus = await this.#ownerStatus(record.owner);
    if (ownerStatus !== "dead") {
      return {
        outcome: "degraded",
        ...diagnostic,
        reasonCode: ownerStatus === "alive"
          ? "PROJECTION_OWNER_STILL_VALID"
          : "PROJECTION_OWNER_VALIDITY_UNCERTAIN",
      };
    }
    const revalidatedRecord = await this.#readLock();
    if (
      revalidatedRecord === null
      || jcsCanonicalJson(revalidatedRecord) !== jcsCanonicalJson(record)
    ) {
      return {
        outcome: "degraded",
        ...diagnostic,
        reasonCode: "PROJECTION_LOCK_CHANGED",
      };
    }
    record = revalidatedRecord;

    if (record.operation === "collect") {
      await rm(join(this.#layout.projections.fitness, LOCK_DIRECTORY), {
        recursive: true,
      });
      await syncDirectory(this.#layout.projections.fitness);
      return {
        outcome: "rolled_back",
        ...diagnostic,
        reasonCode: "PROJECTION_COLLECTION_LOCK_RECOVERED",
      };
    }

    const root = this.#layout.projections.fitness;
    const revisions = join(root, "revisions");
    const temporary = join(revisions, record.target.temporary_directory);
    const target = join(revisions, record.target.projection_revision);
    if (
      basename(record.target.temporary_directory) !== record.target.temporary_directory
      || !record.target.temporary_directory.startsWith(".tmp-")
    ) {
      return { outcome: "degraded", ...diagnostic, reasonCode: "PROJECTION_RECOVERY_PATH_UNSAFE" };
    }
    try {
      if (record.phase === "acquired") {
        await rm(temporary, { recursive: true, force: true });
        await rm(join(root, LOCK_DIRECTORY), { recursive: true });
        await syncDirectory(root);
        return {
          outcome: "rolled_back",
          ...diagnostic,
          reasonCode: "PROJECTION_SAFE_TEMP_CLEANED",
        };
      }
      if (record.phase === "temporary_revision_complete") {
        let committed: {
          readonly verified: VerifiedRevision;
          readonly reused: boolean;
        };
        try {
          await verifyRevision(temporary, this.#instanceId, "stella-runtime", "stella-fitness");
          committed = await this.#commitRevision(record, temporary);
        } catch (error: unknown) {
          if (errorCode(error) !== "ENOENT") throw error;
          const verified = await verifyRevision(
            target,
            this.#instanceId,
            "stella-runtime",
            "stella-fitness",
          );
          committed = { verified, reused: true };
        }
        this.#assertVerifiedTarget(record, committed.verified);
        const pointer = pointerFor(
          committed.verified.manifest,
          committed.verified.manifestChecksum,
          record.owner.started_at,
        );
        record = {
          ...record,
          phase: "revision_committed",
          target: {
            ...record.target,
            manifest_checksum: committed.verified.manifestChecksum,
            pointer,
          },
        };
        await this.#writeLock(record);
      }
      if (record.phase === "revision_committed") {
        const verified = await verifyRevision(
          target,
          this.#instanceId,
          "stella-runtime",
          "stella-fitness",
        );
        if (
          verified.manifestChecksum !== record.target.manifest_checksum
          || verified.manifest.source.revision !== record.target.source_revision
        ) {
          throw new Error("PROJECTION_RECOVERY_TARGET_MISMATCH");
        }
        await atomicWriteFile(join(root, "active.json"), jcsCanonicalJson(record.target.pointer));
        record = { ...record, phase: "active_committed" };
        await this.#writeLock(record);
      }
      const verified = await verifyRevision(
        target,
        this.#instanceId,
        "stella-runtime",
        "stella-fitness",
      );
      const activeBytes = await readSecureFile(root, join(root, "active.json"), MAX_POINTER_BYTES);
      if (
        verified.manifestChecksum !== record.target.manifest_checksum
        || activeBytes.toString("utf8") !== jcsCanonicalJson(record.target.pointer)
      ) {
        throw new Error("PROJECTION_RECOVERY_ACTIVE_MISMATCH");
      }
      await rm(join(root, LOCK_DIRECTORY), { recursive: true });
      await syncDirectory(root);
      return {
        outcome: "recovered",
        phase: "active_committed",
        ownerId: record.owner.id,
        projectionRevision: record.target.projection_revision,
        reasonCode: "PROJECTION_PUBLICATION_RECOVERED",
      };
    } catch {
      return {
        outcome: "degraded",
        phase: record.phase,
        ownerId: record.owner.id,
        projectionRevision: record.target.projection_revision,
        reasonCode: "PROJECTION_RECOVERY_UNCERTAIN",
      };
    }
  }

  async collectOrphanRevisions(
    options: CollectOrphanRevisionsOptions,
  ): Promise<ProjectionCollectionResult> {
    if (!Number.isFinite(options.gracePeriodMs) || options.gracePeriodMs < 0) {
      throw new Error("PROJECTION_GRACE_PERIOD_INVALID");
    }
    const root = this.#layout.projections.fitness;
    const revisions = join(root, "revisions");
    await mkdir(revisions, { recursive: true, mode: 0o700 });
    await this.#acquireCollectionLock();
    const protectedRevisions = new Set<string>();
    try {
      let pointerValue: unknown = null;
      try {
        const pointerBytes = await readSecureFile(
          root,
          join(root, "active.json"),
          MAX_POINTER_BYTES,
        );
        pointerValue = JSON.parse(pointerBytes.toString("utf8")) as unknown;
      } catch (error: unknown) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      if (pointerValue !== null) {
        if (!validateContract("context-projection-pointer", pointerValue).valid || !isRecord(pointerValue)) {
          throw new Error("PROJECTION_POINTER_INVALID");
        }
        if (
          pointerValue.instance_id !== this.#instanceId
          || pointerValue.producer_id !== "stella-runtime"
          || pointerValue.consumer_id !== "stella-fitness"
        ) {
          throw new Error("PROJECTION_POINTER_IDENTITY_MISMATCH");
        }
        if (typeof pointerValue.projection_revision === "string") {
          protectedRevisions.add(pointerValue.projection_revision);
        }
        if (typeof pointerValue.last_verified_revision === "string") {
          protectedRevisions.add(pointerValue.last_verified_revision);
        }
      }
      const retainedRevision = await this.#readLastVerifiedRevision();
      if (retainedRevision !== null) protectedRevisions.add(retainedRevision);

      const removedRevisions: string[] = [];
      const gracePeriodRevisions: string[] = [];
      const now = Date.parse(this.#now());
      for (const name of (await readdir(revisions)).sort()) {
        if (!/^projection-[a-f0-9]{64}$/u.test(name)) continue;
        const revisionRoot = join(revisions, name);
        const metadata = await lstat(revisionRoot);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new Error("PROJECTION_ORPHAN_UNSAFE");
        }
        if (protectedRevisions.has(name)) continue;
        if (now - metadata.mtimeMs <= options.gracePeriodMs) {
          gracePeriodRevisions.push(name);
          continue;
        }
        await verifyRevision(
          revisionRoot,
          this.#instanceId,
          "stella-runtime",
          "stella-fitness",
        );
        await rm(revisionRoot, { recursive: true });
        removedRevisions.push(name);
      }
      await syncDirectory(revisions);
      await rm(join(root, LOCK_DIRECTORY), { recursive: true });
      await syncDirectory(root);
      return {
        removedRevisions,
        protectedRevisions: [...protectedRevisions].sort(),
        gracePeriodRevisions,
      };
    } catch (error: unknown) {
      throw new Error("PROJECTION_COLLECTION_FAILED", { cause: error });
    }
  }

  async #readLastVerifiedRevision(): Promise<string | null> {
    const metadataDirectory = await this.#runtimeMetadataDirectory();
    try {
      const bytes = await readSecureFile(
        metadataDirectory,
        join(metadataDirectory, RETENTION_FILE),
        MAX_POINTER_BYTES,
      );
      const value = JSON.parse(bytes.toString("utf8")) as unknown;
      if (
        !isRecord(value)
        || value.schema_version !== "stella.projection-retention/v1"
        || value.instance_id !== this.#instanceId
        || typeof value.last_verified_revision !== "string"
        || !/^projection-[a-f0-9]{64}$/u.test(value.last_verified_revision)
      ) {
        throw new Error("PROJECTION_RETENTION_INVALID");
      }
      return value.last_verified_revision;
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  async recordLastVerifiedRevision(projectionRevision: string): Promise<void> {
    if (!/^projection-[a-f0-9]{64}$/u.test(projectionRevision)) {
      throw new Error("PROJECTION_RETENTION_REVISION_INVALID");
    }
    await verifyRevision(
      join(this.#layout.projections.fitness, "revisions", projectionRevision),
      this.#instanceId,
      "stella-runtime",
      "stella-fitness",
    );
    const metadataDirectory = await this.#runtimeMetadataDirectory();
    await atomicWriteFile(join(metadataDirectory, RETENTION_FILE), jcsCanonicalJson({
      schema_version: "stella.projection-retention/v1",
      instance_id: this.#instanceId,
      last_verified_revision: projectionRevision,
    }));
  }

  async #consume(
    root: string,
    producerId: "stella-runtime" | "stella-fitness",
    consumerId: "stella-fitness" | "stella-runtime",
    purpose: ProjectionConsumptionPurpose,
  ): Promise<ConsumedProjection> {
    let changed: unknown;
    for (let attempt = 0; attempt < POINTER_RETRY_LIMIT; attempt += 1) {
      let revisionTreeCheck: Promise<void> | null = null;
      try {
        return await runProjectionConsumerConformance({
          instanceId: this.#instanceId,
          producerId,
          consumerId,
          purpose,
          port: {
            readPointer: () => readSecureFile(root, join(root, "active.json"), MAX_POINTER_BYTES),
            readManifest: async (revision) => {
              const revisionRoot = join(root, "revisions", revision);
              const bytes = await readSecureFile(
                revisionRoot,
                join(revisionRoot, "manifest.json"),
                MAX_PROJECTION_FILE_BYTES,
              );
              revisionTreeCheck = assertRevisionTree(revisionRoot, parseManifest(bytes));
              await revisionTreeCheck;
              return bytes;
            },
            readPayload: async (revision, path) => {
              await revisionTreeCheck;
              const revisionRoot = join(root, "revisions", revision);
              return readSecureFile(
                revisionRoot,
                join(revisionRoot, path),
                MAX_PROJECTION_FILE_BYTES,
              );
            },
          },
        });
      } catch (error: unknown) {
        if (error instanceof Error && error.message === "PROJECTION_POINTER_CHANGED") {
          changed = error;
          continue;
        }
        throw error;
      }
    }
    throw changed instanceof Error ? changed : new Error("PROJECTION_POINTER_UNSTABLE");
  }

  readFitnessProjection(
    purpose: "identity_background" | "material_identity_update",
  ): Promise<ConsumedProjection> {
    return this.#consume(
      this.#layout.projections.fitness,
      "stella-runtime",
      "stella-fitness",
      purpose,
    );
  }

  readStellaProjection(
    purpose: Extract<ProjectionConsumptionPurpose, "fitness_history" | "current_fitness_state">,
  ): Promise<ConsumedProjection> {
    return this.#consume(
      this.#layout.projections.stella,
      "stella-fitness",
      "stella-runtime",
      purpose,
    );
  }
}
