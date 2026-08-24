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
  readonly canonicalSourceSnapshot: {
    readonly revision: string;
    readonly sourceAsOf: string;
  };
  readonly determinismLedger: ProjectionDeterminismLedger;
  readonly categories: readonly ProjectionCategory[];
  readonly sourceReferences: readonly ProjectionSourceReference[];
  readonly conflicts: readonly ProjectionConflict[];
  readonly retractions: readonly ProjectionRetraction[];
  readonly capabilities: readonly ProjectionCapability[];
  readonly payloads: readonly ProjectionPayloadInput[];
  readonly generatedAt: string;
}

export interface RuntimeIdentityContextValue {
  readonly content: string;
  readonly sourceReferenceIds: readonly string[];
}

export type StableFitnessBackgroundKind =
  | "equipment_access"
  | "injury_constraints"
  | "mobility_constraints"
  | "training_experience";

export interface StableFitnessBackgroundValue extends RuntimeIdentityContextValue {
  readonly kind: StableFitnessBackgroundKind;
}

export interface RuntimeIdentityContextInput {
  readonly stellaIdentity?: RuntimeIdentityContextValue;
  readonly stellaPersona?: RuntimeIdentityContextValue;
  readonly preferredName?: RuntimeIdentityContextValue;
  readonly language?: RuntimeIdentityContextValue;
  readonly timezone?: RuntimeIdentityContextValue;
  readonly communicationPreferences?: RuntimeIdentityContextValue;
  readonly stableFitnessBackground?: readonly StableFitnessBackgroundValue[];
}

export interface BuildRuntimeIdentityProjectionInput {
  readonly instanceId: string;
  readonly canonicalSourceSnapshot: {
    readonly revision: string;
    readonly sourceAsOf: string;
  };
  readonly determinismLedger: ProjectionDeterminismLedger;
  readonly sourceReferences: readonly ProjectionSourceReference[];
  readonly sourcePolicies: readonly RuntimeIdentitySourcePolicy[];
  readonly context: RuntimeIdentityContextInput;
  readonly generatedAt: string;
}

export type RuntimeIdentitySourceDataClass =
  | "public_identity"
  | "stable_fitness_background";

export interface RuntimeIdentitySourcePolicy {
  readonly sourceReferenceId: string;
  readonly authorityRecordKind: "cognitive" | "personal_model";
  readonly dataClasses: readonly RuntimeIdentitySourceDataClass[];
  readonly allowedEntryIds: readonly RuntimeIdentityEntryId[];
  readonly sensitivity: "projection_safe";
}

export interface RuntimeIdentityProjectionPublication extends ProjectionPublication {
  readonly sourcePolicies: readonly RuntimeIdentitySourcePolicy[];
}

export interface ProjectionPublication {
  readonly projectionRevision: string;
  readonly manifest: ProjectionManifest;
  readonly manifestBytes: Buffer;
  readonly manifestChecksum: string;
  readonly payloads: readonly ProjectionPayloadArtifact[];
}

interface ProjectionDeterminismBinding {
  readonly sourceRevision: string;
  readonly sourceAsOf: string;
  readonly projectionRevision: string;
  readonly payloadChecksums: readonly {
    readonly path: string;
    readonly checksum: string;
  }[];
}

export class ProjectionDeterminismLedger {
  readonly #bindings = new Map<string, string>();

  constructor(manifests: readonly ProjectionManifest[] = []) {
    for (const manifest of manifests) {
      this.claim({
        sourceRevision: manifest.source.revision,
        sourceAsOf: manifest.source.as_of,
        projectionRevision: manifest.projection_revision,
        payloadChecksums: manifest.payloads.map(({ path, checksum: value }) => ({
          path,
          checksum: value,
        })),
      });
    }
  }

  claim(binding: ProjectionDeterminismBinding): void {
    const fingerprint = jcsCanonicalJson(binding);
    const existing = this.#bindings.get(binding.sourceRevision);
    if (existing !== undefined && existing !== fingerprint) {
      throw new Error("PROJECTION_SOURCE_NONDETERMINISTIC");
    }
    this.#bindings.set(binding.sourceRevision, fingerprint);
  }
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
  readonly pointerRevision: string;
  readonly manifestChecksum: string;
  readonly sourceRevision: string;
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

const normalizeProjectionCollections = (value: Pick<
  ProjectionManifest,
  | "categories"
  | "source_references"
  | "conflicts"
  | "retractions"
  | "capabilities"
  | "payloads"
>) => ({
  categories: [...value.categories].sort(compare),
  source_references: [...value.source_references]
      .sort((left, right) => compare(left.id, right.id) || compare(left.path, right.path)),
  conflicts: [...value.conflicts]
      .map((conflict) => ({
        ...conflict,
        source_reference_ids: [...conflict.source_reference_ids].sort(compare),
      }))
      .sort((left, right) => compare(left.id, right.id)),
  retractions: [...value.retractions].sort((left, right) => compare(left.id, right.id)),
  capabilities: [...value.capabilities].sort((left, right) => compare(left.id, right.id)),
  payloads: [...value.payloads].sort((left, right) => compare(left.path, right.path)),
});

const assertProjectionCollectionOrder = (manifest: ProjectionManifest): void => {
  const ordered = normalizeProjectionCollections(manifest);
  for (const key of Object.keys(ordered) as (keyof typeof ordered)[]) {
    if (jcsCanonicalJson(manifest[key]) !== jcsCanonicalJson(ordered[key])) {
      throw new Error("PROJECTION_COLLECTION_ORDER_INVALID");
    }
  }
};

const normalizeIdentityContext = (
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const categories = value.categories as readonly string[];
  const entries = value.entries as readonly Readonly<Record<string, unknown>>[];
  return {
    ...value,
    categories: [...categories].sort(compare),
    entries: entries
      .map((entry) => ({
        ...entry,
        id: entry["id"],
        category: entry["category"],
        source_reference_ids: [
          ...(entry.source_reference_ids as readonly string[]),
        ].sort(compare),
      }))
      .sort((left, right) =>
        compare(String(left.category), String(right.category))
        || compare(String(left.id), String(right.id)),
      ),
  };
};

interface IdentityContextExpectation {
  readonly instanceId: string;
  readonly producerId: ProjectionParticipant;
  readonly consumerId: ProjectionParticipant;
  readonly sourceRevision: string;
  readonly sourceAsOf: string;
}

const validateAndNormalizeIdentityContext = (
  value: unknown,
  expected: IdentityContextExpectation,
): Readonly<Record<string, unknown>> | null => {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || (value as Readonly<Record<string, unknown>>).schema_version
      !== "stella.identity-context/v1"
  ) {
    return null;
  }
  if (!validateContract("identity-context", value).valid) {
    throw new Error("IDENTITY_CONTEXT_INVALID");
  }
  const identity = value as Readonly<Record<string, unknown>>;
  if (
    identity.instance_id !== expected.instanceId
    || identity.producer_id !== expected.producerId
    || identity.consumer_id !== expected.consumerId
    || identity.source_revision !== expected.sourceRevision
    || identity.as_of !== expected.sourceAsOf
  ) {
    throw new Error("IDENTITY_CONTEXT_SOURCE_MISMATCH");
  }
  return normalizeIdentityContext(identity);
};

export function runProjectionProducerConformance(
  input: BuildProjectionPublicationInput,
): ProjectionPublication {
  assertUnique(input.payloads, ({ path }) => path, "PROJECTION_PAYLOAD_PATH_DUPLICATE");
  assertUnique(input.sourceReferences, ({ id }) => id, "PROJECTION_SOURCE_REFERENCE_DUPLICATE");
  assertUnique(input.sourceReferences, ({ path }) => path, "PROJECTION_SOURCE_PATH_DUPLICATE");
  assertUnique(input.conflicts, ({ id }) => id, "PROJECTION_CONFLICT_DUPLICATE");
  assertUnique(input.retractions, ({ id }) => id, "PROJECTION_RETRACTION_DUPLICATE");
  assertUnique(input.capabilities, ({ id }) => id, "PROJECTION_CAPABILITY_DUPLICATE");
  assertUnique(input.categories, (category) => category, "PROJECTION_CATEGORY_DUPLICATE");

  const { revision: sourceRevision, sourceAsOf } = input.canonicalSourceSnapshot;
  const payloads = input.payloads
    .map(({ path, mediaType, value }) => {
      const identity = mediaType === "application/json"
        ? validateAndNormalizeIdentityContext(value, {
            instanceId: input.instanceId,
            producerId: input.producerId,
            consumerId: input.consumerId,
            sourceRevision,
            sourceAsOf,
          })
        : null;
      const canonicalValue = identity ?? value;
      const bytes = canonicalizeProjectionPayload(canonicalValue, mediaType);
      return {
        path,
        mediaType,
        bytes,
        checksum: checksum(bytes),
      };
    })
    .sort((left, right) => compare(left.path, right.path));

  const payloadMetadata = payloads.map((payload) => ({
    path: payload.path,
    media_type: payload.mediaType,
    byte_length: payload.bytes.byteLength,
    checksum: payload.checksum,
  }));
  const normalized = normalizeProjectionCollections({
    categories: input.categories,
    source_references: input.sourceReferences,
    conflicts: input.conflicts,
    retractions: input.retractions,
    capabilities: input.capabilities,
    payloads: payloadMetadata,
  });
  const revisionSeed = {
    instance_id: input.instanceId,
    producer_id: input.producerId,
    consumer_id: input.consumerId,
    source: {
      revision: sourceRevision,
      as_of: sourceAsOf,
    },
    ...normalized,
  };
  const projectionRevision = projectionRevisionFor(revisionSeed);
  const manifest: ProjectionManifest = {
    schema_version: "stella.context-projection-manifest/v1",
    instance_id: input.instanceId,
    producer_id: input.producerId,
    consumer_id: input.consumerId,
    projection_revision: projectionRevision,
    source: {
      revision: sourceRevision,
      as_of: sourceAsOf,
    },
    ...normalized,
    generated_at: input.generatedAt,
  };
  if (!validateContract("context-projection-manifest", manifest).valid) {
    throw new Error("PROJECTION_MANIFEST_INVALID");
  }
  const manifestBytes = Buffer.from(jcsCanonicalJson(manifest), "utf8");
  input.determinismLedger.claim({
    sourceRevision,
    sourceAsOf,
    projectionRevision,
    payloadChecksums: normalized.payloads.map(({ path, checksum: value }) => ({
      path,
      checksum: value,
    })),
  });
  return {
    projectionRevision,
    manifest,
    manifestBytes,
    manifestChecksum: checksum(manifestBytes),
    payloads,
  };
}

const IDENTITY_FIELDS = [
  ["communicationPreferences", "communication-preferences"],
  ["language", "language"],
  ["preferredName", "preferred-name"],
  ["stellaIdentity", "stella-identity"],
  ["stellaPersona", "stella-persona"],
  ["timezone", "timezone"],
] as const;

const FITNESS_BACKGROUND_IDS = {
  equipment_access: "fitness-equipment-access",
  injury_constraints: "fitness-injury-constraints",
  mobility_constraints: "fitness-mobility-constraints",
  training_experience: "fitness-training-experience",
} as const satisfies Readonly<Record<StableFitnessBackgroundKind, string>>;

export type RuntimeIdentityEntryId =
  | (typeof IDENTITY_FIELDS)[number][1]
  | (typeof FITNESS_BACKGROUND_IDS)[keyof typeof FITNESS_BACKGROUND_IDS];

const RUNTIME_IDENTITY_ENTRY_CATEGORIES = new Map<string, ProjectionCategory>([
  ...IDENTITY_FIELDS.map(([, id]) => [id, "identity"] as const),
  ...Object.values(FITNESS_BACKGROUND_IDS).map((id) => [id, "background"] as const),
]);

export const runtimeIdentityContextCategoryForEntryId = (
  id: string,
): ProjectionCategory | null => RUNTIME_IDENTITY_ENTRY_CATEGORIES.get(id) ?? null;

export const assertRuntimeIdentityContextPolicy = (
  value: unknown,
  sourceReferences: readonly ProjectionSourceReference[],
  sourcePolicies: readonly RuntimeIdentitySourcePolicy[],
): void => {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || !validateContract("identity-context", value).valid
  ) {
    throw new Error("IDENTITY_CONTEXT_PAYLOAD_INVALID");
  }
  const context = value as Readonly<Record<string, unknown>>;
  if (!Array.isArray(sourcePolicies)) {
    throw new Error("IDENTITY_CONTEXT_SOURCE_POLICY_INVALID");
  }
  const referencesById = new Map(sourceReferences.map((reference) => [reference.id, reference]));
  const policiesByReferenceId = new Map(
    sourcePolicies.map((policy) => [policy.sourceReferenceId, policy]),
  );
  if (
    referencesById.size !== sourceReferences.length
    || policiesByReferenceId.size !== sourcePolicies.length
    || sourcePolicies.length !== sourceReferences.length
  ) {
    throw new Error("IDENTITY_CONTEXT_SOURCE_POLICY_INVALID");
  }
  const usedReferenceIds = new Set<string>();
  for (const entry of context.entries as readonly Readonly<Record<string, unknown>>[]) {
    const entryId = String(entry.id);
    const category = runtimeIdentityContextCategoryForEntryId(entryId);
    if (category === null || entry.category !== category) {
      throw new Error("IDENTITY_CONTEXT_FIELD_NOT_ALLOWLISTED");
    }
    for (const sourceReferenceId of entry.source_reference_ids as readonly string[]) {
      const reference = referencesById.get(sourceReferenceId);
      const policy = policiesByReferenceId.get(sourceReferenceId);
      if (reference === undefined || policy === undefined) {
        throw new Error("IDENTITY_CONTEXT_SOURCE_REFERENCE_UNKNOWN");
      }
      const requiredDataClass = category === "background"
        ? "stable_fitness_background"
        : "public_identity";
      const requiresCognitiveSource = ["stella-identity", "stella-persona"]
        .includes(entryId);
      const sourcePathValid = policy.authorityRecordKind === "cognitive"
        ? /^cognitive\/[a-z0-9][a-z0-9._-]{0,127}\/entity\.md$/u.test(reference.path)
        : /^personal-model\/[a-z0-9][a-z0-9._-]{0,127}\.md$/u.test(reference.path);
      if (
        policy.sensitivity !== "projection_safe"
        || !policy.dataClasses.includes(requiredDataClass)
        || !policy.allowedEntryIds.includes(entryId)
        || !sourcePathValid
        || policy.authorityRecordKind !== (requiresCognitiveSource
          ? "cognitive"
          : "personal_model")
      ) {
        throw new Error("IDENTITY_CONTEXT_SOURCE_POLICY_FORBIDDEN");
      }
      usedReferenceIds.add(sourceReferenceId);
    }
  }
  if (usedReferenceIds.size !== sourceReferences.length) {
    throw new Error("IDENTITY_CONTEXT_SOURCE_REFERENCE_UNUSED");
  }
};

const assertContextValue = (
  value: RuntimeIdentityContextValue,
  sourceReferenceIds: ReadonlySet<string>,
): void => {
  if (value.content.length === 0 || value.sourceReferenceIds.length === 0) {
    throw new Error("IDENTITY_CONTEXT_VALUE_INVALID");
  }
  for (const sourceReferenceId of value.sourceReferenceIds) {
    if (!sourceReferenceIds.has(sourceReferenceId)) {
      throw new Error("IDENTITY_CONTEXT_SOURCE_REFERENCE_UNKNOWN");
    }
  }
};

export function buildRuntimeIdentityProjection(
  input: BuildRuntimeIdentityProjectionInput,
): RuntimeIdentityProjectionPublication {
  const sourceReferenceIds = new Set(input.sourceReferences.map(({ id }) => id));
  const identityEntries: Array<Readonly<Record<string, unknown>>> = [];
  for (const [field, id] of IDENTITY_FIELDS) {
    const value = input.context[field];
    if (value === undefined) continue;
    assertContextValue(value, sourceReferenceIds);
    if (field === "language") {
      try {
        Intl.getCanonicalLocales(value.content);
      } catch {
        throw new Error("IDENTITY_CONTEXT_LANGUAGE_INVALID");
      }
    }
    if (field === "timezone") {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: value.content }).format(0);
      } catch {
        throw new Error("IDENTITY_CONTEXT_TIMEZONE_INVALID");
      }
    }
    identityEntries.push({
      id,
      category: "identity",
      content: value.content,
      source_reference_ids: value.sourceReferenceIds,
    });
  }
  const backgroundEntries = (input.context.stableFitnessBackground ?? []).map((value) => {
    assertContextValue(value, sourceReferenceIds);
    const id = FITNESS_BACKGROUND_IDS[value.kind];
    if (id === undefined) throw new Error("IDENTITY_CONTEXT_BACKGROUND_NOT_ALLOWLISTED");
    return {
      id,
      category: "background" as const,
      content: value.content,
      source_reference_ids: value.sourceReferenceIds,
    };
  });
  const entries = [...identityEntries, ...backgroundEntries];
  if (entries.length === 0) throw new Error("IDENTITY_CONTEXT_EMPTY");
  const categories: ProjectionCategory[] = [];
  if (backgroundEntries.length > 0) categories.push("background");
  if (identityEntries.length > 0) categories.push("identity");
  const capabilities: ProjectionCapability[] = [];
  if (backgroundEntries.length > 0) {
    capabilities.push({ id: "background_context", state: "available" });
  }
  if (identityEntries.length > 0) {
    capabilities.push({ id: "identity_context", state: "available" });
  }
  const identityContext = {
    schema_version: "stella.identity-context/v1",
    instance_id: input.instanceId,
    producer_id: "stella-runtime",
    consumer_id: "stella-fitness",
    source_revision: input.canonicalSourceSnapshot.revision,
    as_of: input.canonicalSourceSnapshot.sourceAsOf,
    categories,
    entries,
  } as const;
  assertRuntimeIdentityContextPolicy(
    identityContext,
    input.sourceReferences,
    input.sourcePolicies,
  );
  const publication = runProjectionProducerConformance({
    instanceId: input.instanceId,
    producerId: "stella-runtime",
    consumerId: "stella-fitness",
    canonicalSourceSnapshot: input.canonicalSourceSnapshot,
    determinismLedger: input.determinismLedger,
    categories,
    sourceReferences: input.sourceReferences,
    conflicts: [],
    retractions: [],
    capabilities,
    payloads: [{
      path: "payloads/identity-context.json",
      mediaType: "application/json",
      value: identityContext,
    }],
    generatedAt: input.generatedAt,
  });
  return { ...publication, sourcePolicies: input.sourcePolicies };
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
      const payloadValue = parseJcsDocument(bytes, "PROJECTION_PAYLOAD");
      const identity = validateAndNormalizeIdentityContext(payloadValue, {
        instanceId: options.instanceId,
        producerId: options.producerId,
        consumerId: options.consumerId,
        sourceRevision: manifest.source.revision,
        sourceAsOf: manifest.source.as_of,
      });
      if (identity !== null) {
        if (
          jcsCanonicalJson(identity)
          !== decodeUtf8(bytes, "PROJECTION_PAYLOAD_UTF8_INVALID")
        ) {
          throw new Error("PROJECTION_COLLECTION_ORDER_INVALID");
        }
      }
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
    pointerRevision: pointer.pointer_revision as string,
    manifestChecksum: pointer.manifest_checksum as string,
    sourceRevision: pointer.source_revision as string,
    asOf: manifest.source.as_of,
    manifest,
    payloads,
  };
}
