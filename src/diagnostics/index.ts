import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  ActivationReceipt,
  ActiveGenerationPointer,
  InstanceRuntimeConfig,
} from "../contracts/index.js";
import { atomicWriteFile } from "../core/persistence.js";
import { validateContract } from "../contracts/index.js";
import { verifyGeneration } from "../generation/index.js";
import { resolveCompatibilityMatrixRow } from "../compatibility/index.js";
import {
  ACTIVATION_RECEIPTS_DIRECTORY,
  ACTIVE_GENERATION_POINTER_FILE,
  calculateRuntimeConfigIdentityChecksum,
} from "../runtime/binding.js";

const execFileAsync = promisify(execFile);

export const RUNTIME_HEALTH_FILE = "runtime-health.json";

export const DRIFT_REASON_CODES = {
  staleReceipt: "STALE_RECEIPT",
  configDrift: "CONFIG_DRIFT",
  indexDrift: "INDEX_DRIFT",
  incompatibleHost: "INCOMPATIBLE_HOST",
  runtimeStorageUnavailable: "RUNTIME_STORAGE_UNAVAILABLE",
  pluginDiscoveryFailed: "PLUGIN_DISCOVERY_FAILED",
  authorityInputInvalid: "AUTHORITY_INPUT_INVALID",
  publicCorpusUnhealthy: "PUBLIC_CORPUS_UNHEALTHY",
  activeGenerationUnavailable: "ACTIVE_GENERATION_UNAVAILABLE",
  reconciliationMissing: "HEALTH_RECONCILIATION_MISSING",
} as const;

export type DriftReasonCode = typeof DRIFT_REASON_CODES[keyof typeof DRIFT_REASON_CODES];
export type ReconciliationTrigger = "startup" | "sync" | "periodic" | "detected_drift";
export type LifecycleOutcome =
  | "accepted"
  | "published"
  | "pending_activation"
  | "activated"
  | "rollback_restored"
  | "gated";

export interface ActiveGenerationHealthSnapshot {
  readonly pointer: ActiveGenerationPointer;
  readonly receipt: ActivationReceipt;
  readonly manifest: {
    readonly sync_generation: string;
    readonly source_revision: string;
    readonly files: readonly {
      readonly path: string;
      readonly checksum: string;
    }[];
  };
}

export interface ReceiptValidity {
  readonly valid: boolean;
  readonly reasonCodes: readonly DriftReasonCode[];
}

export interface GenerationOperationalStatus {
  readonly status: "ok" | "degraded";
  readonly activeSourceRevision: string | null;
  readonly latestSourceRevision: string;
  readonly synchronizationGap: boolean;
  readonly pendingActivation: boolean;
  readonly generationId: string | null;
  readonly activationReceiptId: string | null;
  readonly manifestChecksum: string | null;
  readonly receiptValid: boolean;
  readonly reasonCodes: readonly DriftReasonCode[];
}

export const inspectGenerationStatus = async (input: {
  readonly active: ActiveGenerationHealthSnapshot | null;
  readonly latestSourceRevision: string;
  readonly receiptValidity: ReceiptValidity;
}): Promise<GenerationOperationalStatus> => {
  const activeRevision = input.active?.pointer.source_revision ?? null;
  const synchronizationGap = activeRevision !== input.latestSourceRevision;
  const reasonCodes = [...new Set(input.receiptValidity.reasonCodes)].sort();
  return {
    status: input.receiptValidity.valid ? "ok" : "degraded",
    activeSourceRevision: activeRevision,
    latestSourceRevision: input.latestSourceRevision,
    synchronizationGap,
    pendingActivation: synchronizationGap,
    generationId: input.active?.pointer.generation_id ?? null,
    activationReceiptId: input.active?.pointer.activation_receipt_id ?? null,
    manifestChecksum: input.active?.pointer.manifest_checksum ?? null,
    receiptValid: input.receiptValidity.valid,
    reasonCodes,
  };
};

const loadJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

export const readLatestAuthorityRevision = async (
  authorityDirectory: string,
): Promise<string> => {
  const result = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: authorityDirectory,
    encoding: "utf8",
  });
  const revision = result.stdout.trim();
  if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error("AUTHORITY_HEAD_INVALID");
  return revision;
};

export const loadActiveGenerationHealth = async (
  config: InstanceRuntimeConfig,
): Promise<ActiveGenerationHealthSnapshot> => {
  const pointerValue = await loadJson(join(
    config.runtime_storage,
    ACTIVE_GENERATION_POINTER_FILE,
  ));
  if (!validateContract("active-generation-pointer", pointerValue).valid) {
    throw new Error("ACTIVE_GENERATION_POINTER_INVALID");
  }
  const pointer = pointerValue as ActiveGenerationPointer;
  const receiptValue = await loadJson(join(
    config.runtime_storage,
    ACTIVATION_RECEIPTS_DIRECTORY,
    `${pointer.activation_receipt_id}.json`,
  ));
  if (!validateContract("activation-receipt", receiptValue).valid) {
    throw new Error("ACTIVATION_RECEIPT_INVALID");
  }
  const verified = await verifyGeneration(join(
    config.generation_storage,
    pointer.generation_id,
  ));
  if (!verified.valid || verified.manifest === null || verified.manifestChecksum === null) {
    throw new Error(`ACTIVE_GENERATION_INVALID:${verified.issues.join(",")}`);
  }
  if (verified.manifestChecksum !== pointer.manifest_checksum) {
    throw new Error("ACTIVATION_MANIFEST_IDENTITY_STALE");
  }
  return {
    pointer,
    receipt: receiptValue as ActivationReceipt,
    manifest: verified.manifest,
  };
};

export const validateActiveReceipt = async (
  active: ActiveGenerationHealthSnapshot,
  config: InstanceRuntimeConfig,
  hostVersion: string,
  nodeVersion: string,
): Promise<ReceiptValidity> => {
  let matrixRow;
  try {
    matrixRow = await resolveCompatibilityMatrixRow({
      openclawVersion: hostVersion,
      nodeVersion,
    });
  } catch {
    return {
      valid: false,
      reasonCodes: [DRIFT_REASON_CODES.incompatibleHost],
    };
  }
  const projection = active.manifest.files.find((file) =>
    file.path === "projection-entries.json");
  const receipt = active.receipt;
  const pointer = active.pointer;
  const valid =
    pointer.instance_id === config.instance_id &&
    receipt.instance_id === config.instance_id &&
    receipt.receipt_id === pointer.activation_receipt_id &&
    receipt.generation_id === pointer.generation_id &&
    receipt.source_revision === pointer.source_revision &&
    receipt.manifest_checksum === pointer.manifest_checksum &&
    active.manifest.sync_generation === pointer.generation_id &&
    active.manifest.source_revision === pointer.source_revision &&
    projection !== undefined &&
    receipt.projection_checksum === projection.checksum &&
    receipt.host_config_checksum === calculateRuntimeConfigIdentityChecksum(config) &&
    receipt.release_channel === matrixRow.releaseChannel &&
    receipt.openclaw_version === hostVersion &&
    receipt.node_version === nodeVersion;
  if (valid) return { valid: true, reasonCodes: [] };
  const configDrift = receipt.host_config_checksum !==
    calculateRuntimeConfigIdentityChecksum(config);
  const hostDrift = receipt.openclaw_version !== hostVersion ||
    receipt.node_version !== nodeVersion ||
    receipt.release_channel !== matrixRow.releaseChannel;
  return {
    valid: false,
    reasonCodes: [
      ...(configDrift ? [DRIFT_REASON_CODES.configDrift] : []),
      ...(hostDrift ? [DRIFT_REASON_CODES.incompatibleHost] : []),
      ...(!configDrift && !hostDrift ? [DRIFT_REASON_CODES.staleReceipt] : []),
    ],
  };
};

export const inspectStoredGenerationStatus = async (input: {
  readonly config: InstanceRuntimeConfig;
  readonly latestSourceRevision: string;
  readonly hostVersion: string;
  readonly nodeVersion: string;
}): Promise<GenerationOperationalStatus> => {
  let pointer: ActiveGenerationPointer;
  try {
    const value = await loadJson(join(
      input.config.runtime_storage,
      ACTIVE_GENERATION_POINTER_FILE,
    ));
    if (!validateContract("active-generation-pointer", value).valid) {
      throw new Error("ACTIVE_GENERATION_POINTER_INVALID");
    }
    pointer = value as ActiveGenerationPointer;
  } catch {
    return {
      status: "degraded",
      activeSourceRevision: null,
      latestSourceRevision: input.latestSourceRevision,
      synchronizationGap: true,
      pendingActivation: true,
      generationId: null,
      activationReceiptId: null,
      manifestChecksum: null,
      receiptValid: false,
      reasonCodes: [DRIFT_REASON_CODES.activeGenerationUnavailable],
    };
  }
  const identity = {
    activeSourceRevision: pointer.source_revision,
    latestSourceRevision: input.latestSourceRevision,
    synchronizationGap: pointer.source_revision !== input.latestSourceRevision,
    pendingActivation: pointer.source_revision !== input.latestSourceRevision,
    generationId: pointer.generation_id,
    activationReceiptId: pointer.activation_receipt_id,
    manifestChecksum: pointer.manifest_checksum,
  };
  try {
    const active = await loadActiveGenerationHealth(input.config);
    const validity = await validateActiveReceipt(
      active,
      input.config,
      input.hostVersion,
      input.nodeVersion,
    );
    return {
      status: validity.valid ? "ok" : "degraded",
      ...identity,
      receiptValid: validity.valid,
      reasonCodes: validity.reasonCodes,
    };
  } catch (error: unknown) {
    const reason = reasonForError(error);
    return {
      status: "degraded",
      ...identity,
      receiptValid: false,
      reasonCodes: [reason === DRIFT_REASON_CODES.activeGenerationUnavailable
        ? DRIFT_REASON_CODES.staleReceipt
        : reason],
    };
  }
};

interface CheckResult {
  readonly id: string;
  readonly status: "pass" | "fail";
  readonly reasonCodes: readonly DriftReasonCode[];
}

interface AuthorityInputResult {
  readonly status: "pass" | "fail";
  readonly sourceRevision: string | null;
  readonly reasonCodes: readonly DriftReasonCode[];
}

export interface RuntimeSelfCheckResult {
  readonly status: "pass" | "fail";
  readonly authorityInput: AuthorityInputResult;
  readonly environment: {
    readonly status: "pass" | "fail";
    readonly checks: readonly CheckResult[];
  };
  readonly reasonCodes: readonly DriftReasonCode[];
}

export interface RuntimeHealthOptions {
  readonly config: InstanceRuntimeConfig;
  readonly hostVersion: string;
  readonly nodeVersion: string;
  readonly pluginDiscovered: () => boolean | Promise<boolean>;
  readonly hostCapabilities?: () => boolean | Promise<boolean>;
  readonly authority: {
    validate(): Promise<{ readonly sourceRevision: string }>;
  };
  readonly configIdentity: { verify(): Promise<boolean | ReceiptValidity> };
  readonly retrieval: { verify(active: ActiveGenerationHealthSnapshot): Promise<void> };
  readonly publicCorpus?: { verify(): Promise<{ readonly adapterId: string }> };
  readonly active: { load(): Promise<ActiveGenerationHealthSnapshot> };
  readonly now?: () => string;
}

export interface ReconciliationReceipt {
  readonly schemaVersion: "cognitive-runtime.runtime-health/v1";
  readonly instanceId: string;
  readonly trigger: ReconciliationTrigger;
  readonly status: "pass" | "fail";
  readonly reasonCodes: readonly DriftReasonCode[];
  readonly checkedAt: string;
}

export interface RuntimeHealthMetrics {
  readonly lifecycle: {
    readonly accepted: number;
    readonly published: number;
    readonly pendingActivation: number;
    readonly activated: number;
    readonly rollbackRestored: number;
    readonly gated: number;
  };
}

export interface LifecycleTrace {
  readonly sequence: number;
  readonly outcome: LifecycleOutcome;
  readonly occurredAt: string;
}

const reasonForError = (error: unknown): DriftReasonCode => {
  const message = error instanceof Error ? error.message : String(error);
  if (/ACTIVATION_(RECEIPT|.*IDENTITY)|RECEIPT/.test(message)) {
    return DRIFT_REASON_CODES.staleReceipt;
  }
  if (/CONFIG/.test(message)) return DRIFT_REASON_CODES.configDrift;
  if (/HOST|OPENCLAW_VERSION|NODE_VERSION/.test(message)) {
    return DRIFT_REASON_CODES.incompatibleHost;
  }
  if (/PUBLIC.*CORPUS/.test(message)) return DRIFT_REASON_CODES.publicCorpusUnhealthy;
  if (/INDEX|RETRIEVAL|SEARCH|MEMORY_GET|SENTINEL/.test(message)) {
    return DRIFT_REASON_CODES.indexDrift;
  }
  return DRIFT_REASON_CODES.activeGenerationUnavailable;
};

class DriftReasonsError extends Error {
  readonly reasonCodes: readonly DriftReasonCode[];

  constructor(reasonCodes: readonly DriftReasonCode[]) {
    super(reasonCodes[0] ?? DRIFT_REASON_CODES.staleReceipt);
    this.reasonCodes = reasonCodes;
  }
}

const readReceipt = async (path: string): Promise<ReconciliationReceipt | null> => {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<ReconciliationReceipt>;
    if (
      value.schemaVersion !== "cognitive-runtime.runtime-health/v1" ||
      (value.status !== "pass" && value.status !== "fail") ||
      !Array.isArray(value.reasonCodes)
    ) return null;
    return value as ReconciliationReceipt;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

export class RuntimeHealthMonitor {
  readonly #options: RuntimeHealthOptions;
  readonly #lifecycle = {
    accepted: 0,
    published: 0,
    pendingActivation: 0,
    activated: 0,
    rollbackRestored: 0,
    gated: 0,
  };
  readonly #lifecycleTraces: LifecycleTrace[] = [];
  #reconciliationQueue: Promise<void> = Promise.resolve();

  constructor(options: RuntimeHealthOptions) {
    this.#options = options;
  }

  async #check(
    id: string,
    operation: () => Promise<void>,
    fallback: DriftReasonCode,
  ): Promise<CheckResult> {
    try {
      await operation();
      return { id, status: "pass", reasonCodes: [] };
    } catch (error: unknown) {
      if (error instanceof DriftReasonsError) {
        return { id, status: "fail", reasonCodes: error.reasonCodes };
      }
      const mapped = reasonForError(error);
      return { id, status: "fail", reasonCodes: [
        mapped === DRIFT_REASON_CODES.activeGenerationUnavailable ? fallback : mapped,
      ] };
    }
  }

  async selfCheck(): Promise<RuntimeSelfCheckResult> {
    let authorityInput: AuthorityInputResult;
    try {
      const result = await this.#options.authority.validate();
      authorityInput = { status: "pass", sourceRevision: result.sourceRevision, reasonCodes: [] };
    } catch {
      authorityInput = {
        status: "fail",
        sourceRevision: null,
        reasonCodes: [DRIFT_REASON_CODES.authorityInputInvalid],
      };
    }
    let active: ActiveGenerationHealthSnapshot | null = null;
    try {
      active = await this.#options.active.load();
    } catch {
      active = null;
    }
    const checks = await Promise.all([
      this.#check("runtime_storage", async () => {
        if (!(await stat(this.#options.config.runtime_storage)).isDirectory()) {
          throw new Error("RUNTIME_STORAGE_NOT_DIRECTORY");
        }
        await access(
          this.#options.config.runtime_storage,
          constants.R_OK | constants.W_OK,
        );
      }, DRIFT_REASON_CODES.runtimeStorageUnavailable),
      this.#check("plugin_discovery", async () => {
        if (!await this.#options.pluginDiscovered()) throw new Error("PLUGIN_NOT_DISCOVERED");
      }, DRIFT_REASON_CODES.pluginDiscoveryFailed),
      this.#check("host_capabilities", async () => {
        await resolveCompatibilityMatrixRow({
          openclawVersion: this.#options.hostVersion,
          nodeVersion: this.#options.nodeVersion,
        });
        if (
          this.#options.hostCapabilities !== undefined &&
          !await this.#options.hostCapabilities()
        ) throw new Error("HOST_CAPABILITIES_INCOMPATIBLE");
      }, DRIFT_REASON_CODES.incompatibleHost),
      this.#check("config_identity", async () => {
        const validity = await this.#options.configIdentity.verify();
        if (typeof validity === "boolean") {
          if (!validity) throw new Error("CONFIG_IDENTITY_DRIFT");
          return;
        }
        if (!validity.valid) {
          throw new DriftReasonsError(validity.reasonCodes);
        }
      }, DRIFT_REASON_CODES.configDrift),
      this.#check("index_retrieval", async () => {
        if (active === null) throw new Error("ACTIVE_GENERATION_UNAVAILABLE");
        await this.#options.retrieval.verify(active);
      }, DRIFT_REASON_CODES.indexDrift),
      this.#check("public_corpus", async () => {
        const adapterId = this.#options.config.adapters.public_corpus;
        if (adapterId === undefined) return;
        const evidence = await this.#options.publicCorpus?.verify();
        if (evidence?.adapterId !== adapterId) throw new Error("PUBLIC_CORPUS_UNHEALTHY");
      }, DRIFT_REASON_CODES.publicCorpusUnhealthy),
    ]);
    const reasonCodes = [...new Set([
      ...authorityInput.reasonCodes,
      ...checks.flatMap((check) => check.reasonCodes),
    ])].sort();
    const environmentStatus = checks.every((check) => check.status === "pass")
      ? "pass" : "fail";
    return {
      status: authorityInput.status === "pass" && environmentStatus === "pass"
        ? "pass" : "fail",
      authorityInput,
      environment: { status: environmentStatus, checks },
      reasonCodes,
    };
  }

  async #performReconciliation(
    trigger: ReconciliationTrigger,
  ): Promise<ReconciliationReceipt> {
    const check = await this.selfCheck();
    const receipt: ReconciliationReceipt = {
      schemaVersion: "cognitive-runtime.runtime-health/v1",
      instanceId: this.#options.config.instance_id,
      trigger,
      status: check.environment.status,
      reasonCodes: check.environment.checks.flatMap((item) => item.reasonCodes),
      checkedAt: this.#options.now?.() ?? new Date().toISOString(),
    };
    await atomicWriteFile(
      join(this.#options.config.runtime_storage, RUNTIME_HEALTH_FILE),
      `${JSON.stringify(receipt)}\n`,
    );
    return receipt;
  }

  reconcile(trigger: ReconciliationTrigger): Promise<ReconciliationReceipt> {
    const result = this.#reconciliationQueue.then(() =>
      this.#performReconciliation(trigger));
    this.#reconciliationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  startPeriodic(intervalMs: number): () => void {
    if (!Number.isInteger(intervalMs) || intervalMs < 1) {
      throw new Error("HEALTH_RECONCILIATION_INTERVAL_INVALID");
    }
    const timer = setInterval(() => {
      void this.reconcile("periodic").catch(() => undefined);
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  async checkRunGate(): Promise<{
    readonly allowed: boolean;
    readonly reasonCodes: readonly DriftReasonCode[];
  }> {
    const receipt = await readReceipt(join(
      this.#options.config.runtime_storage,
      RUNTIME_HEALTH_FILE,
    ));
    const reasonCodes = receipt === null
      ? [DRIFT_REASON_CODES.reconciliationMissing]
      : receipt.reasonCodes;
    return {
      allowed: this.#options.config.mode !== "enforce" || reasonCodes.length === 0,
      reasonCodes,
    };
  }

  recordLifecycle(outcome: LifecycleOutcome): void {
    if (outcome === "accepted") this.#lifecycle.accepted += 1;
    else if (outcome === "published") this.#lifecycle.published += 1;
    else if (outcome === "pending_activation") this.#lifecycle.pendingActivation += 1;
    else if (outcome === "activated") this.#lifecycle.activated += 1;
    else if (outcome === "rollback_restored") this.#lifecycle.rollbackRestored += 1;
    else this.#lifecycle.gated += 1;
    this.#lifecycleTraces.push({
      sequence: this.#lifecycleTraces.length === 0
        ? 1
        : (this.#lifecycleTraces.at(-1)?.sequence ?? 0) + 1,
      outcome,
      occurredAt: this.#options.now?.() ?? new Date().toISOString(),
    });
    if (this.#lifecycleTraces.length > 100) this.#lifecycleTraces.shift();
  }

  metrics(): RuntimeHealthMetrics {
    return { lifecycle: { ...this.#lifecycle } };
  }

  lifecycleTraces(): readonly LifecycleTrace[] {
    return structuredClone(this.#lifecycleTraces);
  }
}
