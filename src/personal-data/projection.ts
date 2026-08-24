import { createHash } from "node:crypto";

import { validateContract } from "../contracts/index.js";
import {
  canonicalizeProjectionPayload,
  jcsCanonicalJson,
  type ProjectionPayloadMediaType,
} from "./canonical.js";

export type ProjectionParticipant = "stella-runtime" | "stella-fitness";
export type ProjectionCategory = "background" | "fitness_history" | "identity";
export type ProjectionCapabilityId =
  | "background_context"
  | "fitness_history_context"
  | "identity_context"
  | "material_identity_update"
  | "current_fitness_state";
export type ProjectionCapabilityState = "available" | "degraded" | "unavailable";

export interface ProjectionSourceReference {
  readonly id: string;
  readonly path: string;
  readonly revision: string;
  readonly checksum: string;
}

export interface ProjectionConflict {
  readonly id: string;
  readonly source_reference_ids: readonly string[];
  readonly summary: string;
}

export interface ProjectionRetraction {
  readonly id: string;
  readonly source_reference_id: string;
  readonly retracted_revision: string;
}

export interface ProjectionCapability {
  readonly id: ProjectionCapabilityId;
  readonly state: ProjectionCapabilityState;
}

export interface ProjectionPayloadInput {
  readonly path: string;
  readonly mediaType: ProjectionPayloadMediaType;
  readonly value: unknown;
}

export interface ProjectionPayloadArtifact {
  readonly path: string;
  readonly mediaType: ProjectionPayloadMediaType;
  readonly bytes: Buffer;
  readonly checksum: string;
}

export interface ProjectionManifest {
  readonly schema_version: "stella.context-projection-manifest/v1";
  readonly instance_id: string;
  readonly producer_id: ProjectionParticipant;
  readonly consumer_id: ProjectionParticipant;
  readonly projection_revision: string;
  readonly source: {
    readonly revision: string;
    readonly as_of: string;
  };
  readonly categories: readonly ProjectionCategory[];
  readonly source_references: readonly ProjectionSourceReference[];
  readonly conflicts: readonly ProjectionConflict[];
  readonly retractions: readonly ProjectionRetraction[];
  readonly capabilities: readonly ProjectionCapability[];
  readonly payloads: readonly {
    readonly path: string;
    readonly media_type: ProjectionPayloadMediaType;
    readonly byte_length: number;
    readonly checksum: string;
  }[];
  readonly generated_at: string;
}

export interface BuildProjectionPublicationInput {
  readonly instanceId: string;
  readonly producerId: ProjectionParticipant;
  readonly consumerId: ProjectionParticipant;
  readonly sourceRevision: string;
  readonly sourceAsOf: string;
  readonly categories: readonly ProjectionCategory[];
  readonly sourceReferences: readonly ProjectionSourceReference[];
  readonly conflicts: readonly ProjectionConflict[];
  readonly retractions: readonly ProjectionRetraction[];
  readonly capabilities: readonly ProjectionCapability[];
  readonly payloads: readonly ProjectionPayloadInput[];
  readonly generatedAt: string;
}

export interface ProjectionPublication {
  readonly projectionRevision: string;
  readonly manifest: ProjectionManifest;
  readonly manifestBytes: Buffer;
  readonly manifestChecksum: string;
  readonly payloads: readonly ProjectionPayloadArtifact[];
}

export type ProjectionConsumptionPurpose =
  | "identity_background"
  | "material_identity_update"
  | "fitness_history"
  | "current_fitness_state";

export interface ProjectionConsumerPort {
  readPointer(): Promise<Uint8Array>;
  readManifest(projectionRevision: string): Promise<Uint8Array>;
  readPayload(projectionRevision: string, path: string): Promise<Uint8Array>;
}

export interface ProjectionConsumerConformanceOptions {
  readonly instanceId: string;
  readonly producerId: ProjectionParticipant;
  readonly consumerId: ProjectionParticipant;
  readonly purpose: ProjectionConsumptionPurpose;
  readonly port: ProjectionConsumerPort;
}

export interface ConsumedProjection {
  readonly status: "active" | "stale";
  readonly projectionRevision: string;
  readonly asOf: string;
  readonly manifest: ProjectionManifest;
  readonly payloads: readonly ProjectionPayloadArtifact[];
}

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const checksum = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const assertUnique = <T>(
  values: readonly T[],
  key: (value: T) => string,
  reason: string,
): void => {
  const identities = values.map(key);
  if (new Set(identities).size !== identities.length) {
    throw new Error(reason);
  }
};

const projectionRevisionFor = (seed: {
  readonly instance_id: string;
  readonly producer_id: ProjectionParticipant;
  readonly consumer_id: ProjectionParticipant;
  readonly source: { readonly revision: string; readonly as_of: string };
  readonly categories: readonly ProjectionCategory[];
  readonly source_references: readonly ProjectionSourceReference[];
  readonly conflicts: readonly ProjectionConflict[];
  readonly retractions: readonly ProjectionRetraction[];
  readonly capabilities: readonly ProjectionCapability[];
  readonly payloads: readonly {
    readonly path: string;
    readonly media_type: ProjectionPayloadMediaType;
    readonly byte_length: number;
    readonly checksum: string;
  }[];
}): string => `projection-${createHash("sha256")
  .update(jcsCanonicalJson({
    schema_version: "stella.context-projection-revision-seed/v1",
    ...seed,
  }))
  .digest("hex")}`;

const assertProjectionCollectionOrder = (manifest: ProjectionManifest): void => {
  const ordered = {
    categories: [...manifest.categories].sort(compare),
    source_references: [...manifest.source_references]
      .sort((left, right) => compare(left.id, right.id) || compare(left.path, right.path)),
    conflicts: [...manifest.conflicts]
      .map((conflict) => ({
        ...conflict,
        source_reference_ids: [...conflict.source_reference_ids].sort(compare),
      }))
      .sort((left, right) => compare(left.id, right.id)),
    retractions: [...manifest.retractions].sort((left, right) => compare(left.id, right.id)),
    capabilities: [...manifest.capabilities].sort((left, right) => compare(left.id, right.id)),
    payloads: [...manifest.payloads].sort((left, right) => compare(left.path, right.path)),
  };
  for (const key of Object.keys(ordered) as (keyof typeof ordered)[]) {
    if (jcsCanonicalJson(manifest[key]) !== jcsCanonicalJson(ordered[key])) {
      throw new Error("PROJECTION_COLLECTION_ORDER_INVALID");
    }
  }
};

export function buildProjectionPublication(
  input: BuildProjectionPublicationInput,
): ProjectionPublication {
  assertUnique(input.payloads, ({ path }) => path, "PROJECTION_PAYLOAD_PATH_DUPLICATE");
  assertUnique(input.sourceReferences, ({ id }) => id, "PROJECTION_SOURCE_REFERENCE_DUPLICATE");
  assertUnique(input.sourceReferences, ({ path }) => path, "PROJECTION_SOURCE_PATH_DUPLICATE");
  assertUnique(input.conflicts, ({ id }) => id, "PROJECTION_CONFLICT_DUPLICATE");
  assertUnique(input.retractions, ({ id }) => id, "PROJECTION_RETRACTION_DUPLICATE");
  assertUnique(input.capabilities, ({ id }) => id, "PROJECTION_CAPABILITY_DUPLICATE");
  assertUnique(input.categories, (category) => category, "PROJECTION_CATEGORY_DUPLICATE");

  const payloads = input.payloads
    .map(({ path, mediaType, value }) => {
      if (
        mediaType === "application/json"
        && typeof value === "object"
        && value !== null
        && "schema_version" in value
        && (value as Readonly<Record<string, unknown>>).schema_version === "stella.identity-context/v1"
      ) {
        if (!validateContract("identity-context", value).valid) {
          throw new Error("IDENTITY_CONTEXT_INVALID");
        }
        const identity = value as Readonly<Record<string, unknown>>;
        if (
          identity.instance_id !== input.instanceId
          || identity.producer_id !== input.producerId
          || identity.consumer_id !== input.consumerId
          || identity.source_revision !== input.sourceRevision
          || identity.as_of !== input.sourceAsOf
        ) {
          throw new Error("IDENTITY_CONTEXT_SOURCE_MISMATCH");
        }
      }
      const bytes = canonicalizeProjectionPayload(value, mediaType);
      return {
        path,
        mediaType,
        bytes,
        checksum: checksum(bytes),
      };
    })
    .sort((left, right) => compare(left.path, right.path));

  const categories = [...input.categories].sort(compare);
  const sourceReferences = input.sourceReferences
    .map((reference) => ({ ...reference }))
    .sort((left, right) => compare(left.id, right.id) || compare(left.path, right.path));
  const conflicts = input.conflicts
    .map((conflict) => ({
      ...conflict,
      source_reference_ids: [...conflict.source_reference_ids].sort(compare),
    }))
    .sort((left, right) => compare(left.id, right.id));
  const retractions = input.retractions
    .map((retraction) => ({ ...retraction }))
    .sort((left, right) => compare(left.id, right.id));
  const capabilities = input.capabilities
    .map((capability) => ({ ...capability }))
    .sort((left, right) => compare(left.id, right.id));
  const payloadMetadata = payloads.map((payload) => ({
    path: payload.path,
    media_type: payload.mediaType,
    byte_length: payload.bytes.byteLength,
    checksum: payload.checksum,
  }));
  const revisionSeed = {
    instance_id: input.instanceId,
    producer_id: input.producerId,
    consumer_id: input.consumerId,
    source: {
      revision: input.sourceRevision,
      as_of: input.sourceAsOf,
    },
    categories,
    source_references: sourceReferences,
    conflicts,
    retractions,
    capabilities,
    payloads: payloadMetadata,
  };
  const projectionRevision = projectionRevisionFor(revisionSeed);
  const manifest: ProjectionManifest = {
    schema_version: "stella.context-projection-manifest/v1",
    instance_id: input.instanceId,
    producer_id: input.producerId,
    consumer_id: input.consumerId,
    projection_revision: projectionRevision,
    source: {
      revision: input.sourceRevision,
      as_of: input.sourceAsOf,
    },
    categories,
    source_references: sourceReferences,
    conflicts,
    retractions,
    capabilities,
    payloads: payloadMetadata,
    generated_at: input.generatedAt,
  };
  if (!validateContract("context-projection-manifest", manifest).valid) {
    throw new Error("PROJECTION_MANIFEST_INVALID");
  }
  const manifestBytes = Buffer.from(jcsCanonicalJson(manifest), "utf8");
  return {
    projectionRevision,
    manifest,
    manifestBytes,
    manifestChecksum: checksum(manifestBytes),
    payloads,
  };
}

export function runProjectionProducerConformance(
  input: BuildProjectionPublicationInput,
): ProjectionPublication {
  return buildProjectionPublication(input);
}

const decodeUtf8 = (bytes: Uint8Array, reason: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(reason);
  }
};

const parseJcsDocument = (bytes: Uint8Array, label: string): unknown => {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error(`${label}_BOM_FORBIDDEN`);
  }
  const text = decodeUtf8(bytes, `${label}_UTF8_INVALID`);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label}_JSON_INVALID`);
  }
  if (jcsCanonicalJson(value) !== text) {
    throw new Error(`${label}_NOT_JCS`);
  }
  return value;
};

const asRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("PROJECTION_DOCUMENT_INVALID");
  }
  return value as Readonly<Record<string, unknown>>;
};

export async function runProjectionConsumerConformance(
  options: ProjectionConsumerConformanceOptions,
): Promise<ConsumedProjection> {
  const firstPointerBytes = Buffer.from(await options.port.readPointer());
  const pointer = asRecord(parseJcsDocument(firstPointerBytes, "PROJECTION_POINTER"));
  if (!validateContract("context-projection-pointer", pointer).valid) {
    throw new Error("PROJECTION_POINTER_INVALID");
  }
  if (
    pointer.instance_id !== options.instanceId
    || pointer.producer_id !== options.producerId
    || pointer.consumer_id !== options.consumerId
  ) {
    throw new Error("PROJECTION_POINTER_IDENTITY_MISMATCH");
  }
  if (pointer.status === "blocked" || pointer.status === "revoked") {
    throw new Error("PROJECTION_NOT_CONSUMABLE");
  }
  if (
    pointer.status === "stale"
    && options.purpose !== "identity_background"
    && options.purpose !== "fitness_history"
  ) {
    throw new Error("PROJECTION_STALE_FORBIDDEN");
  }
  const projectionRevision = pointer.status === "active"
    ? pointer.projection_revision
    : pointer.last_verified_revision;
  if (typeof projectionRevision !== "string") {
    throw new Error("PROJECTION_REVISION_MISSING");
  }

  const manifestBytes = Buffer.from(await options.port.readManifest(projectionRevision));
  const manifestValue = parseJcsDocument(manifestBytes, "PROJECTION_MANIFEST");
  if (!validateContract("context-projection-manifest", manifestValue).valid) {
    throw new Error("PROJECTION_MANIFEST_INVALID");
  }
  const manifest = manifestValue as ProjectionManifest;
  assertProjectionCollectionOrder(manifest);
  assertUnique(manifest.source_references, ({ id }) => id, "PROJECTION_SOURCE_REFERENCE_DUPLICATE");
  assertUnique(manifest.source_references, ({ path }) => path, "PROJECTION_SOURCE_PATH_DUPLICATE");
  assertUnique(manifest.conflicts, ({ id }) => id, "PROJECTION_CONFLICT_DUPLICATE");
  assertUnique(manifest.retractions, ({ id }) => id, "PROJECTION_RETRACTION_DUPLICATE");
  assertUnique(manifest.capabilities, ({ id }) => id, "PROJECTION_CAPABILITY_DUPLICATE");
  if (
    manifest.instance_id !== options.instanceId
    || manifest.producer_id !== options.producerId
    || manifest.consumer_id !== options.consumerId
    || manifest.projection_revision !== projectionRevision
    || manifest.source.revision !== pointer.source_revision
    || manifest.source.as_of !== pointer.as_of
    || checksum(manifestBytes) !== pointer.manifest_checksum
  ) {
    throw new Error("PROJECTION_VERIFICATION_TUPLE_MISMATCH");
  }
  const calculatedRevision = projectionRevisionFor({
    instance_id: manifest.instance_id,
    producer_id: manifest.producer_id,
    consumer_id: manifest.consumer_id,
    source: manifest.source,
    categories: manifest.categories,
    source_references: manifest.source_references,
    conflicts: manifest.conflicts,
    retractions: manifest.retractions,
    capabilities: manifest.capabilities,
    payloads: manifest.payloads,
  });
  if (calculatedRevision !== projectionRevision) {
    throw new Error("PROJECTION_REVISION_MISMATCH");
  }
  const expectedPair = options.purpose === "identity_background"
    || options.purpose === "material_identity_update"
    ? ["stella-runtime", "stella-fitness"]
    : ["stella-fitness", "stella-runtime"];
  if (
    options.producerId !== expectedPair[0]
    || options.consumerId !== expectedPair[1]
  ) {
    throw new Error("PROJECTION_PURPOSE_PAIR_MISMATCH");
  }
  const requiredCapability: readonly ProjectionCapabilityId[] = options.purpose === "identity_background"
    ? ["identity_context", "background_context"]
    : options.purpose === "material_identity_update"
      ? ["material_identity_update"]
      : options.purpose === "fitness_history"
        ? ["fitness_history_context"]
        : ["current_fitness_state"];
  const capabilityStates = new Map(
    manifest.capabilities.map(({ id, state }) => [id, state]),
  );
  if (!requiredCapability.some((id) => capabilityStates.get(id) === "available")) {
    throw new Error("PROJECTION_PURPOSE_CAPABILITY_UNAVAILABLE");
  }
  assertUnique(manifest.payloads, ({ path }) => path, "PROJECTION_PAYLOAD_PATH_DUPLICATE");

  const payloads: ProjectionPayloadArtifact[] = [];
  for (const metadata of manifest.payloads) {
    const bytes = Buffer.from(await options.port.readPayload(projectionRevision, metadata.path));
    if (bytes.byteLength !== metadata.byte_length || checksum(bytes) !== metadata.checksum) {
      throw new Error("PROJECTION_PAYLOAD_CHECKSUM_MISMATCH");
    }
    if (metadata.media_type === "application/json") {
      parseJcsDocument(bytes, "PROJECTION_PAYLOAD");
    } else {
      const text = decodeUtf8(bytes, "PROJECTION_PAYLOAD_UTF8_INVALID");
      if (!canonicalizeProjectionPayload(text, metadata.media_type).equals(bytes)) {
        throw new Error("PROJECTION_PAYLOAD_NOT_CANONICAL");
      }
    }
    payloads.push({
      path: metadata.path,
      mediaType: metadata.media_type,
      bytes,
      checksum: metadata.checksum,
    });
  }

  const secondPointerBytes = Buffer.from(await options.port.readPointer());
  if (!firstPointerBytes.equals(secondPointerBytes)) {
    throw new Error("PROJECTION_POINTER_CHANGED");
  }
  return {
    status: pointer.status as "active" | "stale",
    projectionRevision,
    asOf: manifest.source.as_of,
    manifest,
    payloads,
  };
}
