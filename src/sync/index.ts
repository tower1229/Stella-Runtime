import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  chmod,
  mkdir,
  readFile,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ActivationReceipt,
  ActivationReceiptV3,
  ActiveGenerationPointer,
  ActiveGenerationPointerV3,
  InstanceRuntimeConfig,
} from "../contracts/index.js";
import { validateContract } from "../contracts/index.js";
import {
  resolveCompatibilityMatrixRow,
  type CompatibilityMatrixRow,
} from "../compatibility/index.js";
import type {
  CutoverExecutionOptions,
  CutoverTarget,
} from "../cutover/index.js";
import {
  indexCutoverPublicCorpus,
  validateInstanceCutoverPlan,
  verifyCutoverAcceptance,
  verifyCutoverPrerequisites,
} from "../cutover/index.js";
import { atomicWriteFile } from "../core/persistence.js";
import { canonicalJson as serializeCanonicalJson } from "../core/canonical-json.js";
import {
  buildGeneration,
  verifyGeneration,
  type GenerationDomainProjectionInput,
} from "../generation/index.js";
import {
  ACTIVATION_RECEIPTS_DIRECTORY,
  ACTIVE_GENERATION_POINTER_FILE,
  calculateRuntimeConfigIdentityChecksum,
  FileBindingCompiler,
  type DomainProjectionReaderPort,
} from "../runtime/binding.js";

export const MAINTENANCE_GATE_FILE = "maintenance-gate.json";
export const SYNC_JOURNAL_FILE = "sync-journal.json";

export interface MaintenanceGate {
  readonly targetSourceRevision: string;
  readonly closedAt: string;
  readonly reasonCode?: "DOMAIN_PROJECTION_DRIFT";
}

export interface SyncTarget {
  readonly config: InstanceRuntimeConfig;
  readonly sourceRevision: string;
  readonly syncGeneration: string;
  readonly generationDirectory: string;
  readonly projectionDirectory: string;
  readonly manifestChecksum: string;
  readonly projectionChecksum: string;
  readonly hostConfigChecksum: string;
  readonly expectedIndexEvidence?: {
    readonly searchSentinelChecksum: string;
    readonly getSentinelChecksum: string;
  };
  readonly cutover?: CutoverTarget;
}

export interface HostIndexEvidence {
  readonly deepStatus: "pass";
  readonly generationId: string;
  readonly sourceRevision: string;
  readonly projectionChecksum: string;
  readonly hostConfigChecksum: string;
  readonly searchSentinelChecksum: string;
  readonly getSentinelChecksum: string;
}

export type HostSnapshot = Readonly<Record<string, unknown>>;

export interface HostTransitionPort {
  capture(target: SyncTarget): Promise<HostSnapshot>;
  applyTarget(target: SyncTarget): Promise<void>;
  verifyTarget(target: SyncTarget): Promise<HostIndexEvidence>;
  restore(snapshot: HostSnapshot): Promise<void>;
  verifyPrior(snapshot: HostSnapshot, target: SyncTarget): Promise<HostIndexEvidence>;
}

export interface EligibleRunDrainPort {
  closeAdmission(targetSourceRevision: string): void;
  openAdmission(): void;
  drain(timeoutMs: number): Promise<void>;
}

export interface SyncGenerationOptions {
  readonly config: InstanceRuntimeConfig;
  readonly sourceRevision: string;
  readonly packageVersion: string;
  readonly hostVersion: string;
  readonly nodeVersion: string;
  readonly host: HostTransitionPort;
  readonly runs: EligibleRunDrainPort;
  readonly now?: () => Date;
  readonly cutover?: CutoverExecutionOptions;
  readonly domainProjections?: readonly GenerationDomainProjectionInput[];
  readonly domainProjectionReader?: DomainProjectionReaderPort;
  readonly lifecycle?: {
    recordLifecycle(
      outcome: "pending_activation" | "activated" | "rollback_restored",
    ): void;
  };
}

type ActivationReceiptAny = ActivationReceipt | ActivationReceiptV3;
type ActiveGenerationPointerAny = ActiveGenerationPointer | ActiveGenerationPointerV3;

const activationReceiptContract = (value: unknown) =>
  isRecord(value) && value.schema_version === "cognitive-runtime.activation-receipt/v3"
    ? "activation-receipt-v3" as const
    : "activation-receipt" as const;

const activePointerContract = (value: unknown) =>
  isRecord(value) && value.schema_version === "cognitive-runtime.active-generation-pointer/v3"
    ? "active-generation-pointer-v3" as const
    : "active-generation-pointer" as const;

export interface SyncGenerationResult {
  readonly sourceRevision: string;
  readonly syncGeneration: string;
  readonly reusedGeneration: boolean;
  readonly receiptPath: string;
  readonly pointerPath: string;
}

export interface SyncRecoveryOptions {
  readonly config: InstanceRuntimeConfig;
  readonly hostVersion: string;
  readonly nodeVersion: string;
  readonly host: HostTransitionPort;
  readonly runs?: EligibleRunDrainPort;
  readonly domainProjectionReader?: DomainProjectionReaderPort;
  readonly lifecycle?: {
    recordLifecycle(outcome: "rollback_restored"): void;
  };
}

type SyncPhase =
  | "prepared"
  | "gate_closed"
  | "runs_drained"
  | "host_applied"
  | "host_verified"
  | "receipt_written"
  | "pointer_written"
  | "completed"
  | "prior_restored"
  | "recovery_failed";

interface SyncJournal {
  readonly targetSourceRevision: string;
  readonly syncGeneration: string;
  readonly prior: HostSnapshot;
  readonly priorPointer: unknown | null;
  readonly startedAt: string;
  readonly phase: SyncPhase;
  readonly receiptId?: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalJson = (value: unknown): string =>
  serializeCanonicalJson(value, {
    invalidValueReason: "SYNC_PERSISTED_VALUE_INVALID",
    trailingNewline: true,
  });

const checksum = (value: string | Uint8Array): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

const atomicWrite = async (path: string, value: unknown): Promise<void> =>
  atomicWriteFile(path, canonicalJson(value));

const missingFile = (error: unknown): boolean =>
  isRecord(error) && error.code === "ENOENT";

const inProcessLeaseTails = new Map<string, Promise<void>>();
const leaseContext = new AsyncLocalStorage<ReadonlySet<string>>();

const runWithSyncLease = async <T>(
  runtimeStorage: string,
  operation: () => Promise<T>,
): Promise<T> => {
  await mkdir(runtimeStorage, { recursive: true, mode: 0o700 });
  await chmod(runtimeStorage, 0o700);
  const leaseKey = join(runtimeStorage, ".sync-lock.sqlite");
  const activeLeases = leaseContext.getStore();
  if (activeLeases?.has(leaseKey) === true) return operation();
  const prior = inProcessLeaseTails.get(leaseKey) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  inProcessLeaseTails.set(leaseKey, current);
  await prior;
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(leaseKey);
    await chmod(leaseKey, 0o600);
    database.exec("PRAGMA busy_timeout = 300000");
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = await leaseContext.run(
        new Set([...(activeLeases ?? []), leaseKey]),
        operation,
      );
      database.exec("COMMIT");
      return result;
    } catch (error: unknown) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database?.close();
    release?.();
    if (inProcessLeaseTails.get(leaseKey) === current) {
      inProcessLeaseTails.delete(leaseKey);
    }
  }
};

export async function loadMaintenanceGate(
  runtimeStorage: string,
): Promise<MaintenanceGate | null> {
  let value: unknown;
  try {
    value = await readJson(join(resolve(runtimeStorage), MAINTENANCE_GATE_FILE));
  } catch (error: unknown) {
    if (missingFile(error)) return null;
    throw new Error("MAINTENANCE_GATE_INVALID", { cause: error });
  }
  if (
    !isRecord(value) ||
    typeof value.target_source_revision !== "string" ||
    typeof value.closed_at !== "string" ||
    (value.reason_code !== undefined && value.reason_code !== "DOMAIN_PROJECTION_DRIFT")
  ) {
    throw new Error("MAINTENANCE_GATE_INVALID");
  }
  return {
    targetSourceRevision: value.target_source_revision,
    closedAt: value.closed_at,
    ...(value.reason_code === undefined ? {} : { reasonCode: value.reason_code }),
  };
}

const writeGate = async (
  runtimeStorage: string,
  gate: MaintenanceGate,
): Promise<void> => atomicWrite(join(runtimeStorage, MAINTENANCE_GATE_FILE), {
  target_source_revision: gate.targetSourceRevision,
  closed_at: gate.closedAt,
  ...(gate.reasonCode === undefined ? {} : { reason_code: gate.reasonCode }),
});

export async function closeMaintenanceGate(
  runtimeStorage: string,
  targetSourceRevision?: string,
  now: Date = new Date(),
): Promise<MaintenanceGate> {
  let revision = targetSourceRevision;
  if (revision === undefined) {
    const pointer = await readJson(join(resolve(runtimeStorage), ACTIVE_GENERATION_POINTER_FILE));
    if (!isRecord(pointer) || typeof pointer.source_revision !== "string") {
      throw new Error("MAINTENANCE_GATE_TARGET_INVALID");
    }
    revision = pointer.source_revision;
  }
  const gate = {
    targetSourceRevision: revision,
    closedAt: now.toISOString(),
    reasonCode: "DOMAIN_PROJECTION_DRIFT" as const,
  };
  await writeGate(resolve(runtimeStorage), gate);
  return gate;
}

const openGate = async (runtimeStorage: string): Promise<void> =>
  rm(join(runtimeStorage, MAINTENANCE_GATE_FILE), { force: true });

const writeJournal = async (
  runtimeStorage: string,
  journal: SyncJournal,
): Promise<void> => atomicWrite(join(runtimeStorage, SYNC_JOURNAL_FILE), {
  target_source_revision: journal.targetSourceRevision,
  sync_generation: journal.syncGeneration,
  prior: journal.prior,
  prior_pointer: journal.priorPointer,
  started_at: journal.startedAt,
  phase: journal.phase,
  ...(journal.receiptId === undefined ? {} : { receipt_id: journal.receiptId }),
});

const journalAt = (journal: SyncJournal, phase: SyncPhase): SyncJournal => ({
  ...journal,
  phase,
});

const syncPhases = new Set<SyncPhase>([
  "prepared",
  "gate_closed",
  "runs_drained",
  "host_applied",
  "host_verified",
  "receipt_written",
  "pointer_written",
  "completed",
  "prior_restored",
  "recovery_failed",
]);

const loadSyncJournal = async (runtimeStorage: string): Promise<SyncJournal | null> => {
  let value: unknown;
  try {
    value = await readJson(join(runtimeStorage, SYNC_JOURNAL_FILE));
  } catch (error: unknown) {
    if (missingFile(error)) return null;
    throw new Error("SYNC_JOURNAL_INVALID", { cause: error });
  }
  if (
    !isRecord(value) ||
    typeof value.target_source_revision !== "string" ||
    typeof value.sync_generation !== "string" ||
    !isRecord(value.prior) ||
    !("prior_pointer" in value) ||
    typeof value.started_at !== "string" ||
    typeof value.phase !== "string" ||
    !syncPhases.has(value.phase as SyncPhase) ||
    (value.receipt_id !== undefined && typeof value.receipt_id !== "string")
  ) {
    throw new Error("SYNC_JOURNAL_INVALID");
  }
  canonicalJson(value.prior_pointer);
  return {
    targetSourceRevision: value.target_source_revision,
    syncGeneration: value.sync_generation,
    prior: value.prior,
    priorPointer: value.prior_pointer,
    startedAt: value.started_at,
    phase: value.phase as SyncPhase,
    ...(value.receipt_id === undefined ? {} : { receiptId: value.receipt_id }),
  };
};

const loadOptionalPointer = async (runtimeStorage: string): Promise<unknown | null> => {
  try {
    return await readJson(join(runtimeStorage, ACTIVE_GENERATION_POINTER_FILE));
  } catch (error: unknown) {
    if (missingFile(error)) return null;
    throw error;
  }
};

const restorePointer = async (
  runtimeStorage: string,
  pointer: unknown | null,
): Promise<void> => {
  const path = join(runtimeStorage, ACTIVE_GENERATION_POINTER_FILE);
  if (pointer === null) {
    await rm(path, { force: true });
  } else {
    await atomicWrite(path, pointer);
  }
};

const assertHostEvidence = (
  evidence: HostIndexEvidence,
  target: SyncTarget,
): void => {
  if (evidence.deepStatus !== "pass") throw new Error("SYNC_HOST_DEEP_STATUS_FAILED");
  if (
    evidence.generationId !== target.syncGeneration ||
    evidence.sourceRevision !== target.sourceRevision ||
    evidence.projectionChecksum !== target.projectionChecksum ||
    evidence.hostConfigChecksum !== target.hostConfigChecksum
  ) {
    throw new Error("SYNC_HOST_EVIDENCE_IDENTITY_MISMATCH");
  }
  if (
    target.expectedIndexEvidence !== undefined &&
    (
      evidence.searchSentinelChecksum !==
        target.expectedIndexEvidence.searchSentinelChecksum ||
      evidence.getSentinelChecksum !==
        target.expectedIndexEvidence.getSentinelChecksum
    )
  ) {
    throw new Error("SYNC_HOST_SENTINEL_MISMATCH");
  }
};

const activeTarget = async (options: SyncRecoveryOptions): Promise<SyncTarget> => {
  const pointerValue = await loadOptionalPointer(options.config.runtime_storage);
  if (
    pointerValue === null ||
    !validateContract(activePointerContract(pointerValue), pointerValue).valid
  ) {
    throw new Error("SYNC_PRIOR_POINTER_INVALID");
  }
  const pointer = pointerValue as ActiveGenerationPointerAny;
  const receiptValue = await readJson(join(
    resolve(options.config.runtime_storage),
    ACTIVATION_RECEIPTS_DIRECTORY,
    `${pointer.activation_receipt_id}.json`,
  ));
  if (!validateContract(activationReceiptContract(receiptValue), receiptValue).valid) {
    throw new Error("SYNC_PRIOR_RECEIPT_INVALID");
  }
  const receipt = receiptValue as ActivationReceiptAny;
  await new FileBindingCompiler({
    ...(options.domainProjectionReader === undefined ? {} : {
      domainProjectionReader: options.domainProjectionReader,
    }),
  }).compile({
    config: options.config,
    hostVersion: options.hostVersion,
    nodeVersion: options.nodeVersion,
  });
  const generationDirectory = join(
    resolve(options.config.generation_storage),
    pointer.generation_id,
  );
  const verification = await verifyGeneration(generationDirectory);
  if (
    !verification.valid ||
    verification.manifest === null ||
    verification.manifestChecksum === null ||
    verification.manifestChecksum !== pointer.manifest_checksum
  ) {
    throw new Error("SYNC_PRIOR_GENERATION_INVALID");
  }
  const projection = verification.manifest.files.find(
    (file) => file.path === "projection-entries.json",
  );
  if (projection === undefined) throw new Error("SYNC_PRIOR_PROJECTION_MISSING");
  return {
    config: options.config,
    sourceRevision: pointer.source_revision,
    syncGeneration: pointer.generation_id,
    generationDirectory,
    projectionDirectory: join(
      generationDirectory,
      "projections",
      pointer.generation_id,
    ),
    manifestChecksum: verification.manifestChecksum,
    projectionChecksum: projection.checksum,
    hostConfigChecksum: calculateRuntimeConfigIdentityChecksum(options.config),
    expectedIndexEvidence: {
      searchSentinelChecksum: receipt.index_evidence.search_sentinel_checksum,
      getSentinelChecksum: receipt.index_evidence.get_sentinel_checksum,
    },
  };
};

const recoverPrior = async (
  runtimeStorage: string,
  interrupted: SyncJournal,
  options: SyncRecoveryOptions,
): Promise<void> => {
  if (interrupted.priorPointer === null) {
    throw new Error("SYNC_PRIOR_POINTER_MISSING");
  }
  await options.host.restore(interrupted.prior);
  await restorePointer(runtimeStorage, interrupted.priorPointer);
  const target = await activeTarget(options);
  assertHostEvidence(await options.host.verifyPrior(interrupted.prior, target), target);
  await writeJournal(runtimeStorage, journalAt(interrupted, "prior_restored"));
  await openGate(runtimeStorage);
  options.runs?.openAdmission();
  options.lifecycle?.recordLifecycle("rollback_restored");
};

const recoverInterruptedSyncLocked = async (
  options: SyncRecoveryOptions,
): Promise<void> => {
  const runtimeStorage = resolve(options.config.runtime_storage);
  const interrupted = await loadSyncJournal(runtimeStorage);
  if (interrupted === null) return;
  const gate = await loadMaintenanceGate(runtimeStorage);
  if (interrupted.phase === "prepared") {
    await writeJournal(runtimeStorage, journalAt(interrupted, "prior_restored"));
    await openGate(runtimeStorage);
    options.runs?.openAdmission();
    return;
  }
  if (interrupted.phase === "prior_restored") {
    await openGate(runtimeStorage);
    options.runs?.openAdmission();
    return;
  }
  if (
    gate === null &&
    interrupted.phase === "completed"
  ) return;
  options.runs?.closeAdmission(interrupted.targetSourceRevision);
  if (
    interrupted.phase === "completed"
    && gate?.reasonCode === "DOMAIN_PROJECTION_DRIFT"
  ) return;
  try {
    if (interrupted.phase === "completed") {
      const target = await activeTarget(options);
      assertHostEvidence(await options.host.verifyTarget(target), target);
      await openGate(runtimeStorage);
      options.runs?.openAdmission();
      return;
    }
    await recoverPrior(runtimeStorage, interrupted, options);
  } catch (error: unknown) {
    await writeJournal(runtimeStorage, journalAt(interrupted, "recovery_failed"));
    const reason = error instanceof Error ? error.message : "SYNC_RECOVERY_FAILED";
    throw new Error(`SYNC_RECOVERY_FAILED:${reason}`);
  }
};

export async function recoverInterruptedSync(
  options: SyncRecoveryOptions,
): Promise<void> {
  await resolveCompatibilityMatrixRow({
    openclawVersion: options.hostVersion,
    nodeVersion: options.nodeVersion,
  });
  const runtimeStorage = resolve(options.config.runtime_storage);
  return runWithSyncLease(runtimeStorage, () => recoverInterruptedSyncLocked(options));
}

const generationStateDirectory = (config: InstanceRuntimeConfig): string => {
  const storage = resolve(config.generation_storage);
  if (storage === dirname(storage)) throw new Error("GENERATION_STORAGE_INVALID");
  return dirname(storage);
};

const syncGenerationLocked = async (
  options: SyncGenerationOptions,
  matrixRow: CompatibilityMatrixRow,
): Promise<SyncGenerationResult> => {
  const runtimeStorage = resolve(options.config.runtime_storage);
  const now = options.now ?? (() => new Date());
  if (options.cutover !== undefined) {
    validateInstanceCutoverPlan(
      options.cutover.plan,
      options.config.instance_id,
      options.sourceRevision,
    );
  }
  await recoverInterruptedSyncLocked(options);
  if (options.cutover !== undefined) {
    await verifyCutoverPrerequisites(options.cutover, options.sourceRevision);
  }
  const built = await buildGeneration({
    authorityDirectory: options.config.adapters.authority_checkout,
    stateDirectory: generationStateDirectory(options.config),
    generationsDirectory: options.config.generation_storage,
    sourceRevision: options.sourceRevision,
    packageVersion: options.packageVersion,
    ...(options.domainProjections === undefined ? {} : {
      domainProjections: options.domainProjections,
    }),
    ...(options.cutover === undefined ? {} : {
      bootstrapTargets: options.cutover.plan.bootstrap_targets,
    }),
  });
  const verification = await verifyGeneration(built.generationDirectory);
  if (
    !verification.valid ||
    verification.manifest === null ||
    verification.manifestChecksum === null
  ) {
    throw new Error(`SYNC_GENERATION_INVALID:${verification.issues.join(",")}`);
  }
  const projection = verification.manifest.files.find(
    (file) => file.path === "projection-entries.json",
  );
  if (projection === undefined) throw new Error("SYNC_PROJECTION_MISSING");
  options.lifecycle?.recordLifecycle("pending_activation");

  const target: SyncTarget = {
    config: options.config,
    sourceRevision: options.sourceRevision,
    syncGeneration: built.syncGeneration,
    generationDirectory: built.generationDirectory,
    projectionDirectory: join(
      built.generationDirectory,
      "projections",
      built.syncGeneration,
    ),
    manifestChecksum: verification.manifestChecksum,
    projectionChecksum: projection.checksum,
    hostConfigChecksum: calculateRuntimeConfigIdentityChecksum(options.config),
    ...(options.cutover === undefined ? {} : {
      cutover: {
        plan: options.cutover.plan,
        bootstrapProjections: built.bootstrapProjections,
      },
    }),
  };
  const prior = await options.host.capture(target);
  canonicalJson(prior);
  const priorPointer = await loadOptionalPointer(runtimeStorage);
  const startedAt = now().toISOString();
  let journal: SyncJournal = {
    targetSourceRevision: options.sourceRevision,
    syncGeneration: built.syncGeneration,
    prior,
    priorPointer,
    startedAt,
    phase: "prepared",
  };
  await writeJournal(runtimeStorage, journal);
  await writeGate(runtimeStorage, {
    targetSourceRevision: options.sourceRevision,
    closedAt: startedAt,
  });
  options.runs.closeAdmission(options.sourceRevision);
  journal = journalAt(journal, "gate_closed");
  await writeJournal(runtimeStorage, journal);

  let targetCommitted = false;
  try {
    await options.runs.drain(options.config.limits.drain_timeout_ms);
    journal = journalAt(journal, "runs_drained");
    await writeJournal(runtimeStorage, journal);

    await options.host.applyTarget(target);
    journal = journalAt(journal, "host_applied");
    await writeJournal(runtimeStorage, journal);

    if (options.cutover !== undefined) {
      await indexCutoverPublicCorpus(options.cutover, {
        sourceRevision: target.sourceRevision,
        syncGeneration: target.syncGeneration,
      });
    }

    const evidence = await options.host.verifyTarget(target);
    assertHostEvidence(evidence, target);
    if (options.cutover !== undefined) {
      await verifyCutoverAcceptance(options.cutover, {
        sourceRevision: target.sourceRevision,
        syncGeneration: target.syncGeneration,
      });
    }
    journal = journalAt(journal, "host_verified");
    await writeJournal(runtimeStorage, journal);

    const receiptId = `activation-${built.syncGeneration.slice("generation-".length)}`;
    const composite = verification.manifest.schema_version
      === "cognitive-runtime.generation-manifest/v3";
    const receipt = {
      schema_version: composite
        ? "cognitive-runtime.activation-receipt/v3"
        : "cognitive-runtime.activation-receipt/v2",
      receipt_id: receiptId,
      instance_id: options.config.instance_id,
      generation_id: built.syncGeneration,
      source_revision: options.sourceRevision,
      ...(composite ? {
        authority: verification.manifest.authority,
        domains: verification.manifest.domains,
      } : {}),
      manifest_checksum: verification.manifestChecksum,
      projection_checksum: projection.checksum,
      host_config_checksum: target.hostConfigChecksum,
      index_evidence: {
        deep_status: "pass",
        search_sentinel_checksum: evidence.searchSentinelChecksum,
        get_sentinel_checksum: evidence.getSentinelChecksum,
      },
      ...(options.cutover === undefined ? {} : {
        cutover_plan_checksum: options.cutover.plan.checksum,
      }),
      release_channel: matrixRow.releaseChannel,
      openclaw_version: options.hostVersion,
      node_version: options.nodeVersion,
      verified_at: now().toISOString(),
    };
    if (!validateContract(
      composite ? "activation-receipt-v3" : "activation-receipt",
      receipt,
    ).valid) {
      throw new Error("SYNC_ACTIVATION_RECEIPT_INVALID");
    }
    const receiptPath = join(
      runtimeStorage,
      ACTIVATION_RECEIPTS_DIRECTORY,
      `${receiptId}.json`,
    );
    await atomicWrite(receiptPath, receipt);
    journal = { ...journalAt(journal, "receipt_written"), receiptId };
    await writeJournal(runtimeStorage, journal);

    const activatedAt = now().toISOString();
    const pointer = {
      schema_version: composite
        ? "cognitive-runtime.active-generation-pointer/v3"
        : "cognitive-runtime.active-generation-pointer/v2",
      instance_id: options.config.instance_id,
      generation_id: built.syncGeneration,
      source_revision: options.sourceRevision,
      ...(composite ? {
        authority: verification.manifest.authority,
        domains: verification.manifest.domains,
      } : {}),
      manifest_checksum: verification.manifestChecksum,
      activation_receipt_id: receiptId,
      activated_at: activatedAt,
    };
    if (!validateContract(
      composite ? "active-generation-pointer-v3" : "active-generation-pointer",
      pointer,
    ).valid) {
      throw new Error("SYNC_ACTIVE_POINTER_INVALID");
    }
    const pointerPath = join(runtimeStorage, ACTIVE_GENERATION_POINTER_FILE);
    await atomicWrite(pointerPath, pointer);
    journal = journalAt(journal, "pointer_written");
    await writeJournal(runtimeStorage, journal);
    journal = journalAt(journal, "completed");
    await writeJournal(runtimeStorage, journal);
    targetCommitted = true;
    options.lifecycle?.recordLifecycle("activated");
    await openGate(runtimeStorage);
    options.runs.openAdmission();
    return {
      sourceRevision: options.sourceRevision,
      syncGeneration: built.syncGeneration,
      reusedGeneration: built.reused,
      receiptPath,
      pointerPath,
    };
  } catch (error: unknown) {
    if (targetCommitted) throw error;
    try {
      await recoverPrior(runtimeStorage, journal, options);
    } catch (recoveryError: unknown) {
      journal = journalAt(journal, "recovery_failed");
      await writeJournal(runtimeStorage, journal);
      const reason = recoveryError instanceof Error
        ? recoveryError.message
        : "SYNC_RECOVERY_FAILED";
      throw new Error(`SYNC_RECOVERY_FAILED:${reason}`, { cause: error });
    }
    throw error;
  }
};

export async function syncGeneration(
  options: SyncGenerationOptions,
): Promise<SyncGenerationResult> {
  const matrixRow = await resolveCompatibilityMatrixRow({
    openclawVersion: options.hostVersion,
    nodeVersion: options.nodeVersion,
  });
  const runtimeStorage = resolve(options.config.runtime_storage);
  return runWithSyncLease(
    runtimeStorage,
    () => syncGenerationLocked(options, matrixRow),
  );
}
