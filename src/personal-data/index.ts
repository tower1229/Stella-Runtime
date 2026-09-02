import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type {
  StellaPersonalDataLocator,
  StellaPersonalDataRepositoryInitialization,
} from "../contracts/index.js";
import { validateContract } from "../contracts/index.js";
import { jcsCanonicalJson } from "./canonical.js";

export {
  canonicalizeProjectionPayload,
  jcsCanonicalJson,
} from "./canonical.js";
export type { ProjectionPayloadMediaType } from "./canonical.js";
export {
  ProjectionDeterminismLedger,
  buildRuntimeIdentityProjection,
  runProjectionConsumerConformance,
  runProjectionProducerConformance,
} from "./projection.js";
export type {
  BuildProjectionPublicationInput,
  BuildRuntimeIdentityProjectionInput,
  ConsumedProjection,
  ProjectionCapability,
  ProjectionCapabilityId,
  ProjectionCapabilityState,
  ProjectionCategory,
  ProjectionConflict,
  ProjectionConsumerConformanceOptions,
  ProjectionConsumerPort,
  ProjectionConsumptionPurpose,
  ProjectionManifest,
  ProjectionParticipant,
  ProjectionPayloadArtifact,
  ProjectionPayloadInput,
  ProjectionPublication,
  ProjectionRetraction,
  ProjectionSourceReference,
  RuntimeIdentityContextInput,
  RuntimeIdentityContextValue,
  RuntimeIdentityEntryId,
  RuntimeIdentityProjectionPublication,
  RuntimeIdentitySourceDataClass,
  RuntimeIdentitySourcePolicy,
  StableFitnessBackgroundKind,
  StableFitnessBackgroundValue,
} from "./projection.js";
export { FileProjectionExchange } from "./exchange.js";
export type {
  CollectOrphanRevisionsOptions,
  FileProjectionExchangeOptions,
  ProjectionLockOwner,
  ProjectionLockPhase,
  ProjectionOwnerStatus,
  ProjectionCollectionResult,
  ProjectionPublishFailpoint,
  ProjectionPublishResult,
  ProjectionRecoveryResult,
} from "./exchange.js";

const PLUGIN_ID = "cognitive-runtime";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const property = (value: unknown, key: string): unknown =>
  isRecord(value) ? value[key] : undefined;

export interface PersonalDataLayout {
  readonly locator: StellaPersonalDataLocator;
  readonly repository: string;
  readonly stellaRoot: string;
  readonly authority: string;
  readonly authorityRelativeRoot: "stella/authority";
  readonly fitness: string;
  readonly projections: {
    readonly fitness: string;
    readonly stella: string;
  };
}

export interface ResolvePersonalDataLocatorOptions {
  readonly apiConfig: unknown;
  readonly runtimeInstanceId: string;
  readonly ownerUid?: number;
}

export interface InitializePersonalDataRepositoryOptions
  extends ResolvePersonalDataLocatorOptions {
  readonly initializedAt?: string;
}

export interface PersonalDataRepositoryInitializationResult {
  readonly created: boolean;
  readonly manifestPath: string;
  readonly manifest: StellaPersonalDataRepositoryInitialization;
  readonly layout: PersonalDataLayout;
}

const readLocator = (apiConfig: unknown): StellaPersonalDataLocator => {
  const plugins = property(apiConfig, "plugins");
  const entries = property(plugins, "entries");
  const runtimeEntry = property(entries, PLUGIN_ID);
  const runtimeConfig = property(runtimeEntry, "config");
  const locator = property(runtimeConfig, "stella");
  if (!validateContract("personal-data-locator", locator).valid) {
    throw new Error("PERSONAL_DATA_LOCATOR_INVALID");
  }
  return locator as StellaPersonalDataLocator;
};

const assertSecureDirectory = async (
  path: string,
  ownerUid: number,
): Promise<void> => {
  const metadata = await lstat(path).catch(() => {
    throw new Error("PERSONAL_DATA_LAYOUT_MISSING");
  });
  if (metadata.isSymbolicLink()) {
    throw new Error("PERSONAL_DATA_SYMLINK_FORBIDDEN");
  }
  if (!metadata.isDirectory()) {
    throw new Error("PERSONAL_DATA_LAYOUT_NOT_DIRECTORY");
  }
  if (metadata.uid !== ownerUid) {
    throw new Error("PERSONAL_DATA_OWNERSHIP_MISMATCH");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("PERSONAL_DATA_PERMISSIONS_UNSAFE");
  }
  if (await realpath(path) !== path) {
    throw new Error("PERSONAL_DATA_SYMLINK_FORBIDDEN");
  }
};

const ensureSecureDirectory = async (
  path: string,
  ownerUid: number,
): Promise<void> => {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
      throw error;
    }
  }
  await assertSecureDirectory(path, ownerUid);
};

const assertSafeRepositoryParent = async (
  path: string,
  ownerUid: number,
): Promise<void> => {
  const metadata = await lstat(path).catch(() => {
    throw new Error("PERSONAL_DATA_REPOSITORY_PARENT_MISSING");
  });
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || await realpath(path) !== path) {
    throw new Error("PERSONAL_DATA_SYMLINK_FORBIDDEN");
  }
  if (metadata.uid !== ownerUid) {
    throw new Error("PERSONAL_DATA_OWNERSHIP_MISMATCH");
  }
};

const parseRepositoryManifest = (
  bytes: Buffer,
  instanceId: string,
): StellaPersonalDataRepositoryInitialization => {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("PERSONAL_DATA_REPOSITORY_MANIFEST_INVALID");
  }
  if (!validateContract("personal-data-repository", value).valid) {
    throw new Error("PERSONAL_DATA_REPOSITORY_MANIFEST_INVALID");
  }
  const manifest = value as StellaPersonalDataRepositoryInitialization;
  if (manifest.instance_id !== instanceId) {
    throw new Error("PERSONAL_DATA_REPOSITORY_INSTANCE_MISMATCH");
  }
  if (`${jcsCanonicalJson(manifest)}\n` !== bytes.toString("utf8")) {
    throw new Error("PERSONAL_DATA_REPOSITORY_MANIFEST_INVALID");
  }
  return manifest;
};

const readRepositoryManifest = async (
  manifestPath: string,
  instanceId: string,
  ownerUid: number,
): Promise<StellaPersonalDataRepositoryInitialization> => {
  let metadata;
  try {
    metadata = await lstat(manifestPath);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error("PERSONAL_DATA_REPOSITORY_UNINITIALIZED");
    }
    throw error;
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    metadata.size > 4096
  ) {
    throw new Error("PERSONAL_DATA_REPOSITORY_MANIFEST_INVALID");
  }
  if (metadata.uid !== ownerUid || (metadata.mode & 0o077) !== 0) {
    throw new Error("PERSONAL_DATA_REPOSITORY_MANIFEST_PERMISSIONS_UNSAFE");
  }
  const handle = await open(manifestPath, "r");
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.size !== metadata.size
    ) {
      throw new Error("PERSONAL_DATA_REPOSITORY_MANIFEST_INVALID");
    }
    return parseRepositoryManifest(await handle.readFile(), instanceId);
  } finally {
    await handle.close();
  }
};

export async function initializePersonalDataRepository(
  options: InitializePersonalDataRepositoryOptions,
): Promise<PersonalDataRepositoryInitializationResult> {
  const locator = readLocator(options.apiConfig);
  if (locator.instance_id !== options.runtimeInstanceId) {
    throw new Error("PERSONAL_DATA_INSTANCE_MISMATCH");
  }
  const repository = locator.personal_data_repository;
  if (resolve(repository) !== repository) {
    throw new Error("PERSONAL_DATA_PATH_NOT_CANONICAL");
  }
  const ownerUid = options.ownerUid ?? process.getuid?.();
  if (ownerUid === undefined) {
    throw new Error("PERSONAL_DATA_OWNERSHIP_UNSUPPORTED");
  }
  await assertSafeRepositoryParent(dirname(repository), ownerUid);
  for (const path of [
    repository,
    join(repository, "stella"),
    join(repository, "stella", "authority"),
    join(repository, "stella", "fitness"),
    join(repository, "stella", "projections"),
    join(repository, "stella", "projections", "fitness"),
    join(repository, "stella", "projections", "stella"),
  ]) {
    await ensureSecureDirectory(path, ownerUid);
  }
  const layout = await resolvePersonalDataLocator(options);
  const manifestPath = join(layout.stellaRoot, "repository.json");
  try {
    const manifest = await readRepositoryManifest(
      manifestPath,
      options.runtimeInstanceId,
      ownerUid,
    );
    return { created: false, manifestPath, manifest, layout };
  } catch (error: unknown) {
    if (!(error instanceof Error) || error.message !== "PERSONAL_DATA_REPOSITORY_UNINITIALIZED") {
      throw error;
    }
  }

  const requestedInitializedAt = options.initializedAt ?? new Date().toISOString();
  const initializedAt = new Date(requestedInitializedAt);
  if (!Number.isFinite(initializedAt.valueOf())) {
    throw new Error("PERSONAL_DATA_REPOSITORY_MANIFEST_INVALID");
  }
  const manifest: StellaPersonalDataRepositoryInitialization = {
    schema_version: "stella.personal-data-repository/v1",
    instance_id: options.runtimeInstanceId,
    layout_version: "stella.personal-data-layout/v1",
    initialized_at: initializedAt.toISOString(),
  };
  if (!validateContract("personal-data-repository", manifest).valid) {
    throw new Error("PERSONAL_DATA_REPOSITORY_MANIFEST_INVALID");
  }
  const temporaryPath = join(layout.stellaRoot, `.repository-${randomUUID()}.tmp`);
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(`${jcsCanonicalJson(manifest)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  let created = false;
  try {
    await link(temporaryPath, manifestPath);
    created = true;
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
      throw error;
    }
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  const directory = await open(layout.stellaRoot, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return {
    created,
    manifestPath,
    manifest: await readRepositoryManifest(
      manifestPath,
      options.runtimeInstanceId,
      ownerUid,
    ),
    layout,
  };
}

export async function resolvePersonalDataLocator(
  options: ResolvePersonalDataLocatorOptions,
): Promise<PersonalDataLayout> {
  const locator = readLocator(options.apiConfig);
  if (locator.instance_id !== options.runtimeInstanceId) {
    throw new Error("PERSONAL_DATA_INSTANCE_MISMATCH");
  }

  const repository = locator.personal_data_repository;
  if (resolve(repository) !== repository) {
    throw new Error("PERSONAL_DATA_PATH_NOT_CANONICAL");
  }

  const stellaRoot = join(repository, "stella");
  const authority = join(stellaRoot, "authority");
  const fitness = join(stellaRoot, "fitness");
  const projectionRoot = join(stellaRoot, "projections");
  const projections = {
    fitness: join(projectionRoot, "fitness"),
    stella: join(projectionRoot, "stella"),
  } as const;
  const ownerUid = options.ownerUid ?? process.getuid?.();
  if (ownerUid === undefined) {
    throw new Error("PERSONAL_DATA_OWNERSHIP_UNSUPPORTED");
  }
  for (const path of [
    repository,
    stellaRoot,
    authority,
    fitness,
    projectionRoot,
    projections.fitness,
    projections.stella,
  ]) {
    await assertSecureDirectory(path, ownerUid);
  }

  return {
    locator,
    repository,
    stellaRoot,
    authority,
    authorityRelativeRoot: "stella/authority",
    fitness,
    projections,
  };
}
