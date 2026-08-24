import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { StellaPersonalDataLocator } from "../contracts/index.js";
import { validateContract } from "../contracts/index.js";

export {
  canonicalizeProjectionPayload,
  jcsCanonicalJson,
} from "./canonical.js";
export type { ProjectionPayloadMediaType } from "./canonical.js";
export {
  runProjectionConsumerConformance,
  runProjectionProducerConformance,
} from "./projection.js";
export type {
  BuildProjectionPublicationInput,
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
} from "./projection.js";

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
    fitness,
    projections,
  };
}
