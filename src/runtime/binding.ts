import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type {
  ActivationReceipt,
  ActiveGenerationPointer,
  InstanceRuntimeConfig,
  StateView,
} from "../contracts/index.js";
import { validateContract } from "../contracts/index.js";
import { resolveCompatibilityMatrixRow } from "../compatibility/index.js";
import { canonicalJson as serializeCanonicalJson } from "../core/canonical-json.js";
import { verifyGeneration } from "../generation/index.js";
import type { ExplicitContextBinding } from "../packet/index.js";
import {
  calculateRegistryChecksum,
  type RouterRegistry,
  type RouterRegistryEntry,
} from "../router/index.js";
import { createStateManagementPort } from "../state/management.js";

export const ACTIVE_GENERATION_POINTER_FILE = "active-generation.json";
export const ACTIVATION_RECEIPTS_DIRECTORY = "activation-receipts";

export interface ActiveRunBinding {
  readonly syncGeneration: string;
  readonly authorityRevision: string;
  readonly stateViewVersion: string;
  readonly activeGoverningSystem: string | null;
  readonly registry: RouterRegistry;
  readonly context: Omit<ExplicitContextBinding, "currentInput" | "retrievalInstructions">;
  readonly activationReceiptId: string;
}

export interface BindingCompilerInput {
  readonly config: InstanceRuntimeConfig;
  readonly hostVersion: string;
  readonly nodeVersion: string;
}

export interface BindingCompilerPort {
  compile(input: BindingCompilerInput): Promise<ActiveRunBinding>;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalJson = (value: unknown): string => serializeCanonicalJson(value, {
  invalidValueReason: "RUNTIME_CONFIG_IDENTITY_INVALID",
  trailingNewline: true,
});
const checksum = (value: string | Uint8Array): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

const readManifestedJson = async (
  generationDirectory: string,
  manifest: { readonly files: readonly { readonly path: string; readonly checksum: string }[] },
  path: string,
  reason: string,
): Promise<unknown> => {
  const entry = manifest.files.find((file) => file.path === path);
  if (entry === undefined) throw new Error(reason);
  const bytes = await readFile(join(generationDirectory, path));
  if (checksum(bytes) !== entry.checksum) throw new Error(reason);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(reason);
  }
};

const assertContract = (
  name: "active-generation-pointer" | "activation-receipt" | "state-view",
  value: unknown,
  reason: string,
): void => {
  if (!validateContract(name, value).valid) {
    throw new Error(reason);
  }
};

const requireRecord = (value: unknown, reason: string): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) throw new Error(reason);
  return value;
};

const requireString = (value: unknown, reason: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(reason);
  return value;
};

const requireArray = (value: unknown, reason: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new Error(reason);
  return value;
};

const artifactPayload = (
  value: unknown,
  generationId: string,
  sourceRevision: string,
  reason: string,
): Readonly<Record<string, unknown>> => {
  const artifact = requireRecord(value, reason);
  if (
    artifact.sync_generation !== generationId ||
    artifact.source_revision !== sourceRevision ||
    typeof artifact.content_checksum !== "string"
  ) {
    throw new Error(reason);
  }
  return requireRecord(artifact.payload, reason);
};

const parseRegistryEntries = (
  payload: Readonly<Record<string, unknown>>,
  generationId: string,
): readonly RouterRegistryEntry[] => {
  const entries = requireArray(payload.entries, "ACTIVE_REGISTRY_INVALID").map((value) => {
    const entry = requireRecord(value, "ACTIVE_REGISTRY_INVALID");
    const role = requireString(entry.role, "ACTIVE_REGISTRY_INVALID");
    if (![
      "evidence",
      "semantic",
      "governing_system",
      "governing_module",
      "ordinary_framework",
    ].includes(role)) {
      throw new Error("ACTIVE_REGISTRY_INVALID");
    }
    if (entry.syncGeneration !== generationId) throw new Error("ACTIVE_REGISTRY_GENERATION_MISMATCH");
    return {
      id: requireString(entry.id, "ACTIVE_REGISTRY_INVALID"),
      role: role as RouterRegistryEntry["role"],
      version: requireString(entry.version, "ACTIVE_REGISTRY_INVALID"),
      syncGeneration: generationId,
      checksum: requireString(entry.checksum, "ACTIVE_REGISTRY_INVALID"),
      ...(entry.governedBy === undefined ? {} : {
        governedBy: requireString(entry.governedBy, "ACTIVE_REGISTRY_INVALID"),
      }),
    };
  });
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw new Error("ACTIVE_REGISTRY_INVALID");
  }
  return entries;
};

interface ProjectionContent {
  readonly stableId: string;
  readonly content: string;
}

const parseProjectionContent = (
  payload: Readonly<Record<string, unknown>>,
  generationId: string,
): ReadonlyMap<string, ProjectionContent> => {
  const entries = requireArray(payload.entries, "ACTIVE_PROJECTION_INVALID").map((value) => {
    if (!validateContract("projection-entry", value).valid) {
      throw new Error("ACTIVE_PROJECTION_INVALID");
    }
    const entry = value as Readonly<Record<string, unknown>>;
    if (entry.generation_id !== generationId) throw new Error("ACTIVE_PROJECTION_GENERATION_MISMATCH");
    const stableId = requireString(entry.stable_id, "ACTIVE_PROJECTION_INVALID");
    return [stableId, {
      stableId,
      content: requireString(entry.content, "ACTIVE_PROJECTION_INVALID"),
    }] as const;
  });
  const byId = new Map(entries);
  if (byId.size !== entries.length) throw new Error("ACTIVE_PROJECTION_INVALID");
  return byId;
};

const freeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
};

export const calculateRuntimeConfigIdentityChecksum = (
  config: InstanceRuntimeConfig,
): string => checksum(canonicalJson({
  schema_version: config.schema_version,
  instance_id: config.instance_id,
  runtime_storage: config.runtime_storage,
  generation_storage: config.generation_storage,
  host: config.host,
  authority_owner: config.authority_owner,
  limits: config.limits,
  adapters: config.adapters,
}));

const validateActivationChain = (input: {
  readonly pointer: ActiveGenerationPointer;
  readonly receipt: ActivationReceipt;
  readonly manifestChecksum: string;
  readonly projectionChecksum: string;
  readonly config: InstanceRuntimeConfig;
  readonly hostVersion: string;
  readonly nodeVersion: string;
  readonly releaseChannel: string;
  readonly manifestGeneration: string;
  readonly manifestRevision: string;
}): void => {
  const { pointer, receipt } = input;
  if (pointer.instance_id !== input.config.instance_id || receipt.instance_id !== input.config.instance_id) {
    throw new Error("ACTIVE_BINDING_INSTANCE_MISMATCH");
  }
  if (
    pointer.generation_id !== input.manifestGeneration ||
    receipt.generation_id !== pointer.generation_id ||
    pointer.source_revision !== input.manifestRevision ||
    receipt.source_revision !== pointer.source_revision
  ) {
    throw new Error("ACTIVE_BINDING_GENERATION_MISMATCH");
  }
  if (
    pointer.manifest_checksum !== input.manifestChecksum ||
    receipt.manifest_checksum !== input.manifestChecksum
  ) {
    throw new Error("ACTIVE_MANIFEST_CHECKSUM_MISMATCH");
  }
  if (
    pointer.activation_receipt_id !== receipt.receipt_id ||
    receipt.projection_checksum !== input.projectionChecksum
  ) {
    throw new Error("ACTIVATION_RECEIPT_MISMATCH");
  }
  if (receipt.host_config_checksum !== calculateRuntimeConfigIdentityChecksum(input.config)) {
    throw new Error("ACTIVATION_CONFIG_IDENTITY_STALE");
  }
  if (receipt.openclaw_version !== input.hostVersion || receipt.node_version !== input.nodeVersion) {
    throw new Error("ACTIVATION_HOST_IDENTITY_STALE");
  }
  if (receipt.release_channel !== input.releaseChannel) {
    throw new Error("ACTIVATION_HOST_IDENTITY_STALE");
  }
};

export class FileBindingCompiler implements BindingCompilerPort {
  async compile(input: BindingCompilerInput): Promise<ActiveRunBinding> {
    const matrixRow = await resolveCompatibilityMatrixRow({
      openclawVersion: input.hostVersion,
      nodeVersion: input.nodeVersion,
    });
    const runtimeStorage = resolve(input.config.runtime_storage);
    const generationStorage = resolve(input.config.generation_storage);
    let pointerValue: unknown;
    try {
      pointerValue = await readJson(join(runtimeStorage, ACTIVE_GENERATION_POINTER_FILE));
    } catch (error: unknown) {
      if (isRecord(error) && error.code === "ENOENT") throw new Error("ACTIVE_GENERATION_POINTER_MISSING");
      throw error;
    }
    assertContract("active-generation-pointer", pointerValue, "ACTIVE_GENERATION_POINTER_INVALID");
    const pointer = pointerValue as ActiveGenerationPointer;
    const receiptValue = await readJson(join(
      runtimeStorage,
      ACTIVATION_RECEIPTS_DIRECTORY,
      `${pointer.activation_receipt_id}.json`,
    )).catch((error: unknown) => {
      if (isRecord(error) && error.code === "ENOENT") throw new Error("ACTIVATION_RECEIPT_MISSING");
      throw error;
    });
    assertContract("activation-receipt", receiptValue, "ACTIVATION_RECEIPT_INVALID");
    const receipt = receiptValue as ActivationReceipt;

    const generationDirectory = join(generationStorage, pointer.generation_id);
    const verification = await verifyGeneration(generationDirectory);
    if (
      !verification.valid ||
      verification.manifest === null ||
      verification.manifestChecksum === null
    ) {
      throw new Error(`ACTIVE_GENERATION_INVALID:${verification.issues.join(",")}`);
    }
    const projectionManifest = verification.manifest.files.find(
      (file) => file.path === "projection-entries.json",
    );
    if (projectionManifest === undefined) throw new Error("ACTIVE_PROJECTION_MISSING");
    validateActivationChain({
      pointer,
      receipt,
      manifestChecksum: verification.manifestChecksum,
      projectionChecksum: projectionManifest.checksum,
      config: input.config,
      hostVersion: input.hostVersion,
      nodeVersion: input.nodeVersion,
      releaseChannel: matrixRow.releaseChannel,
      manifestGeneration: verification.manifest.sync_generation,
      manifestRevision: verification.manifest.source_revision,
    });

    const [registryValue, projectionValue, governingValue] = await Promise.all([
      readManifestedJson(
        generationDirectory,
        verification.manifest,
        "registry.json",
        "ACTIVE_REGISTRY_CHECKSUM_MISMATCH",
      ),
      readManifestedJson(
        generationDirectory,
        verification.manifest,
        "projection-entries.json",
        "ACTIVE_PROJECTION_CHECKSUM_MISMATCH",
      ),
      readManifestedJson(
        generationDirectory,
        verification.manifest,
        "governing-digest.json",
        "ACTIVE_GOVERNING_CHECKSUM_MISMATCH",
      ),
    ]);
    const generationId = pointer.generation_id;
    const revision = pointer.source_revision;
    const registryPayload = artifactPayload(registryValue, generationId, revision, "ACTIVE_REGISTRY_INVALID");
    const projectionPayload = artifactPayload(projectionValue, generationId, revision, "ACTIVE_PROJECTION_INVALID");
    const governingPayload = artifactPayload(governingValue, generationId, revision, "ACTIVE_GOVERNING_INVALID");
    const generationEntries = parseRegistryEntries(registryPayload, generationId);
    const contentById = parseProjectionContent(projectionPayload, generationId);
    if (generationEntries.some((entry) => !contentById.has(entry.id))) {
      throw new Error("ACTIVE_PROJECTION_REGISTRY_MISMATCH");
    }

    const state = createStateManagementPort({
      stateRoot: runtimeStorage,
      instanceId: input.config.instance_id,
    });
    let stateView: StateView;
    try {
      stateView = await state.view();
    } finally {
      state.close();
    }
    assertContract("state-view", stateView, "STATE_VIEW_INVALID");
    const stateEntries: RouterRegistryEntry[] = stateView.values.map((value) => ({
      id: value.state_id,
      role: "current_state",
      version: stateView.view_version,
      syncGeneration: generationId,
      checksum: checksum(canonicalJson(value)),
    }));
    const allEntries = [...generationEntries, ...stateEntries];
    if (new Set(allEntries.map((entry) => entry.id)).size !== allEntries.length) {
      throw new Error("STATE_VIEW_REGISTRY_ID_COLLISION");
    }

    const activeGoverningSystem = governingPayload.active_governing_system === null
      ? null
      : requireString(governingPayload.active_governing_system, "ACTIVE_GOVERNING_INVALID");
    const governingSystemValue = governingPayload.system;
    const governing = activeGoverningSystem === null
      ? null
      : (() => {
          const system = requireRecord(governingSystemValue, "ACTIVE_GOVERNING_INVALID");
          if (system.id !== activeGoverningSystem) throw new Error("ACTIVE_GOVERNING_INVALID");
          return {
            system: {
              id: activeGoverningSystem,
              version: requireString(system.version, "ACTIVE_GOVERNING_INVALID"),
              content: requireString(system.persistent_kernel, "ACTIVE_GOVERNING_INVALID"),
            },
            modules: requireArray(governingPayload.modules, "ACTIVE_GOVERNING_INVALID").map((value) => {
              const module = requireRecord(value, "ACTIVE_GOVERNING_INVALID");
              return {
                id: requireString(module.id, "ACTIVE_GOVERNING_INVALID"),
                version: requireString(module.version, "ACTIVE_GOVERNING_INVALID"),
                content: requireString(module.runtime_digest, "ACTIVE_GOVERNING_INVALID"),
              };
            }),
          };
        })();
    const entriesForRole = (role: RouterRegistryEntry["role"]) => generationEntries
      .filter((entry) => entry.role === role)
      .map((entry) => ({
        id: entry.id,
        content: contentById.get(entry.id)?.content ?? "",
      }));
    const versionedForRole = (role: RouterRegistryEntry["role"]) => generationEntries
      .filter((entry) => entry.role === role)
      .map((entry) => ({
        id: entry.id,
        version: entry.version,
        content: contentById.get(entry.id)?.content ?? "",
      }));

    return freeze({
      syncGeneration: generationId,
      authorityRevision: revision,
      stateViewVersion: stateView.view_version,
      activeGoverningSystem,
      registry: {
        checksum: calculateRegistryChecksum(allEntries),
        entries: allEntries,
      },
      context: {
        stateView: stateView.values.map((value) => ({
          id: value.state_id,
          content: typeof value.value === "string"
            ? value.value
            : serializeCanonicalJson(value.value, {
                invalidValueReason: "RUNTIME_CONFIG_IDENTITY_INVALID",
              }),
        })),
        semanticClaims: entriesForRole("semantic"),
        evidenceRefs: entriesForRole("evidence"),
        governing,
        frameworks: versionedForRole("ordinary_framework"),
      },
      activationReceiptId: receipt.receipt_id,
    });
  }
}
