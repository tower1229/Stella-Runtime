import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AuthorityCandidate,
  ChangeSet,
  DecisionReceipt,
} from "../contracts/index.js";
import { validateContract } from "../contracts/index.js";
import {
  canonicalJsonEqual,
  checksumCanonicalJson,
  compareCanonicalStrings,
} from "../core/canonical-json.js";

export type PublicationOperation =
  | {
      readonly operation: "write";
      readonly path: string;
      readonly content: string;
      readonly contentChecksum: string;
    }
  | {
      readonly operation: "delete";
      readonly path: string;
      readonly content: null;
      readonly contentChecksum: string;
    };

export interface ChangeSetArtifact {
  readonly changeSet: ChangeSet;
  readonly operations: readonly PublicationOperation[];
}

export interface AuthorityCheckoutInspection {
  readonly kind: "dedicated" | "workspace";
  readonly clean: boolean;
}

export interface AuthorityPublicationCommit {
  readonly changeSetId: string;
  readonly changeSetChecksum: string;
  readonly commitId: string;
  readonly sourceRevision: string;
  readonly treeChecksum: string;
}

export interface AuthorityCommitMetadata {
  readonly subject: string;
  readonly trailers: Readonly<Record<string, string>>;
}

export interface AuthorityPublicationValidation {
  readonly completeEntity: true;
  readonly baseMatches: true;
  readonly schemaValid: true;
  readonly referencesValid: true;
  readonly targetChecksumsValid: true;
  readonly expectedTreeChecksum: string;
}

export interface AuthorityPublishingPort {
  inspectCheckout(): Promise<AuthorityCheckoutInspection>;
  validatePublication(input: {
    readonly changeSet: ChangeSet;
    readonly candidate: AuthorityCandidate;
    readonly operations: readonly PublicationOperation[];
  }): Promise<AuthorityPublicationValidation>;
  findCommit(changeSet: ChangeSet): Promise<AuthorityPublicationCommit | null>;
  commitPublication(input: {
    readonly changeSet: ChangeSet;
    readonly operations: readonly PublicationOperation[];
    readonly expectedTreeChecksum: string;
    readonly metadata: AuthorityCommitMetadata;
  }): Promise<AuthorityPublicationCommit>;
}

export interface ApprovalPublicationFinalization {
  readonly receiptId: string;
  readonly candidateId: string;
  readonly candidateRevision: number;
  readonly candidateChecksum: string;
  readonly changeSetId: string;
  readonly changeSetChecksum: string;
  readonly sourceRevision: string;
}

export interface PreparedApprovalPublication {
  readonly receipt: DecisionReceipt;
  readonly candidate: AuthorityCandidate;
  readonly artifact: ChangeSetArtifact;
  readonly finalization: ApprovalPublicationFinalization | null;
}

export interface ApprovalPublicationPort {
  preparePublication(input: {
    readonly receipt: DecisionReceipt;
    readonly candidate: AuthorityCandidate;
    readonly artifact: ChangeSetArtifact;
  }): Promise<void>;
  loadPreparedPublication(
    changeSetId: string,
  ): Promise<PreparedApprovalPublication | null>;
  finalizePublication(input: ApprovalPublicationFinalization): Promise<void>;
}

export type PublicationFailpoint =
  | "before_authority_write"
  | "after_git_commit"
  | "before_receipt_finalization";

export interface PublicationResult {
  readonly changeSetId: string;
  readonly sourceRevision: string;
  readonly publicationStatus: "Published";
  readonly activationStatus: "Pending Activation";
}

export interface PublicationJournalRecord {
  readonly schemaVersion: "cognitive-runtime.publication-journal/v1";
  readonly status: "prepared" | "committed" | "completed";
  readonly approvalReceiptId: string;
  readonly candidateChecksum: string;
  readonly changeSet: ChangeSet;
  readonly expectedTreeChecksum: string;
  readonly commit: AuthorityPublicationCommit | null;
}

export interface PublicationJournalPort {
  runExclusive<T>(changeSetId: string, operation: () => Promise<T>): Promise<T>;
  load(changeSetId: string): Promise<PublicationJournalRecord | null>;
  write(record: PublicationJournalRecord): Promise<void>;
}

export interface FilePublicationJournalOptions {
  readonly directory: string;
}

export interface FileApprovalPublicationStoreOptions {
  readonly directory: string;
}

interface ApprovalRecord {
  readonly schemaVersion: "cognitive-runtime.approval-publication-record/v1";
  readonly status: "approved" | "prepared" | "consumed";
  readonly receipt: DecisionReceipt;
  readonly candidate: AuthorityCandidate;
  readonly artifact: ChangeSetArtifact | null;
  readonly finalization: ApprovalPublicationFinalization | null;
}

const checksumCanonical = checksumCanonicalJson;

const freeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(freeze);
  return value;
};

const immutableCopy = <T>(value: T): T => freeze(structuredClone(value));

const sameCanonical = canonicalJsonEqual;

const isErrorCode = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

export const calculatePublicationContentChecksum = (content: string): string =>
  `sha256:${createHash("sha256").update(content).digest("hex")}`;

const assertChecksum = (value: string, reason: string): void => {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(reason);
};

const assertValidContract = (
  name: "authority-candidate" | "decision-receipt" | "change-set",
  value: unknown,
): void => {
  if (!validateContract(name, value).valid) {
    throw new Error(`PUBLICATION_CONTRACT_INVALID:${name}`);
  }
};

export function createChangeSet(input: {
  readonly candidate: AuthorityCandidate;
  readonly approvalReceipt: DecisionReceipt;
  readonly operations: readonly PublicationOperation[];
}): ChangeSetArtifact {
  assertValidContract("authority-candidate", input.candidate);
  assertValidContract("decision-receipt", input.approvalReceipt);
  if (
    input.approvalReceipt.decision === "rejected" ||
    input.approvalReceipt.candidate_id !== input.candidate.candidate_id ||
    input.approvalReceipt.candidate_revision !== input.candidate.revision ||
    input.approvalReceipt.candidate_checksum !== input.candidate.checksum ||
    input.approvalReceipt.base_authority_version !== input.candidate.base_authority_version
  ) {
    throw new Error("PUBLICATION_APPROVAL_MISMATCH");
  }
  if (input.operations.length === 0) throw new Error("PUBLICATION_OPERATIONS_EMPTY");
  const normalizedOperations = [...input.operations]
    .map((operation) => immutableCopy(operation))
    .sort((left, right) => compareCanonicalStrings(left.path, right.path));
  if (new Set(normalizedOperations.map((operation) => operation.path)).size !==
    normalizedOperations.length) {
    throw new Error("PUBLICATION_OPERATION_DUPLICATE_PATH");
  }
  for (const operation of normalizedOperations) {
    if (
      operation.operation === "write" &&
      operation.contentChecksum !== calculatePublicationContentChecksum(operation.content)
    ) {
      throw new Error("PUBLICATION_CONTENT_CHECKSUM_MISMATCH");
    }
    if (operation.operation === "delete" && operation.content !== null) {
      throw new Error("PUBLICATION_DELETE_CONTENT_FORBIDDEN");
    }
  }
  const [firstOperation, ...remainingOperations] = normalizedOperations;
  if (firstOperation === undefined) throw new Error("PUBLICATION_OPERATIONS_EMPTY");
  const identity = {
    approval_receipt_id: input.approvalReceipt.receipt_id,
    candidate_id: input.candidate.candidate_id,
    candidate_revision: input.candidate.revision,
    candidate_checksum: input.candidate.checksum,
    base_authority_version: input.candidate.base_authority_version,
    base_checksum: input.candidate.base_checksum,
    operations: [firstOperation, ...remainingOperations].map((operation) => ({
      operation: operation.operation,
      path: operation.path,
      content_checksum: operation.contentChecksum,
    })) as ChangeSet["operations"],
  };
  const identityChecksum = checksumCanonical(identity);
  const payload = {
    schema_version: "cognitive-runtime.change-set/v2" as const,
    change_set_id: `change-set-${identityChecksum.slice("sha256:".length)}`,
    ...identity,
    created_at: input.approvalReceipt.decided_at,
  };
  const changeSet = { ...payload, checksum: checksumCanonical(payload) } satisfies ChangeSet;
  assertValidContract("change-set", changeSet);
  return immutableCopy({ changeSet, operations: normalizedOperations });
}

const assertChangeSetId = (changeSetId: string): void => {
  if (!/^change-set-[a-f0-9]{64}$/.test(changeSetId)) {
    throw new Error("PUBLICATION_CHANGE_SET_ID_INVALID");
  }
};

const assertReceiptId = (receiptId: string): void => {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(receiptId)) {
    throw new Error("APPROVAL_RECEIPT_ID_INVALID");
  }
};

const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const writeProtectedJson = async (
  directory: string,
  path: string,
  value: unknown,
): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
};

const inProcessLeaseTails = new Map<string, Promise<void>>();
const leaseContext = new AsyncLocalStorage<ReadonlySet<string>>();

const runWithDatabaseLease = async <T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const leaseKey = join(directory, ".publication-lock.sqlite");
  const activeLeases = leaseContext.getStore();
  if (activeLeases?.has(leaseKey) === true) return operation();
  const prior = inProcessLeaseTails.get(leaseKey) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
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
    } catch (error) {
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

export class FileApprovalPublicationStore implements ApprovalPublicationPort {
  readonly #directory: string;

  constructor(options: FileApprovalPublicationStoreOptions) {
    if (options.directory.length === 0) throw new Error("APPROVAL_STORE_DIRECTORY_REQUIRED");
    this.#directory = join(options.directory, "approval-records");
  }

  async recordApproval(input: {
    readonly receipt: DecisionReceipt;
    readonly candidate: AuthorityCandidate;
  }): Promise<void> {
    assertReceiptId(input.receipt.receipt_id);
    await runWithDatabaseLease(this.#directory, async () => {
      assertValidContract("authority-candidate", input.candidate);
      assertValidContract("decision-receipt", input.receipt);
      if (
        input.receipt.decision === "rejected" ||
        input.receipt.candidate_id !== input.candidate.candidate_id ||
        input.receipt.candidate_revision !== input.candidate.revision ||
        input.receipt.candidate_checksum !== input.candidate.checksum ||
        input.receipt.base_authority_version !== input.candidate.base_authority_version
      ) {
        throw new Error("APPROVAL_RECORD_MISMATCH");
      }
      const record = immutableCopy({
        schemaVersion: "cognitive-runtime.approval-publication-record/v1" as const,
        status: "approved" as const,
        receipt: input.receipt,
        candidate: input.candidate,
        artifact: null,
        finalization: null,
      });
      const existing = await this.#loadByReceipt(input.receipt.receipt_id);
      if (existing !== null) {
        if (!sameCanonical(existing, record)) throw new Error("APPROVAL_RECORD_CONFLICT");
        return;
      }
      await this.#write(record);
    });
  }

  async preparePublication(input: {
    readonly receipt: DecisionReceipt;
    readonly candidate: AuthorityCandidate;
    readonly artifact: ChangeSetArtifact;
  }): Promise<void> {
    assertReceiptId(input.receipt.receipt_id);
    await runWithDatabaseLease(this.#directory, async () => {
      const record = await this.#loadByReceipt(input.receipt.receipt_id);
      if (record === null) throw new Error("APPROVAL_RECEIPT_INVALID");
      if (
        !sameCanonical(record.receipt, input.receipt) ||
        !sameCanonical(record.candidate, input.candidate)
      ) {
        throw new Error("APPROVAL_RECORD_MISMATCH");
      }
      if (record.status === "consumed") {
        if (sameCanonical(record.artifact, input.artifact)) return;
        throw new Error("APPROVAL_RECEIPT_ALREADY_CONSUMED");
      }
      if (record.status === "prepared") {
        if (sameCanonical(record.artifact, input.artifact)) return;
        throw new Error("APPROVAL_RECEIPT_ALREADY_PREPARED");
      }
      await this.#write(immutableCopy({
        ...record,
        status: "prepared" as const,
        artifact: input.artifact,
      }));
    });
  }

  async loadPreparedPublication(
    changeSetId: string,
  ): Promise<PreparedApprovalPublication | null> {
    assertChangeSetId(changeSetId);
    let names: string[];
    try {
      names = await readdir(this.#directory);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return null;
      throw error;
    }
    let match: PreparedApprovalPublication | null = null;
    for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
      const record = await this.#loadByReceipt(name.slice(0, -".json".length));
      if (record?.artifact?.changeSet.change_set_id !== changeSetId) continue;
      const prepared = {
        receipt: record.receipt,
        candidate: record.candidate,
        artifact: record.artifact,
        finalization: record.finalization,
      } satisfies PreparedApprovalPublication;
      if (match !== null && !sameCanonical(match, prepared)) {
        throw new Error("PUBLICATION_APPROVAL_CONFLICT");
      }
      match = prepared;
    }
    return match === null ? null : immutableCopy(match);
  }

  async finalizePublication(input: ApprovalPublicationFinalization): Promise<void> {
    assertReceiptId(input.receiptId);
    assertChangeSetId(input.changeSetId);
    assertChecksum(input.changeSetChecksum, "PUBLICATION_FINALIZATION_INVALID");
    assertChecksum(input.candidateChecksum, "PUBLICATION_FINALIZATION_INVALID");
    if (input.sourceRevision.length === 0 || input.candidateRevision < 1) {
      throw new Error("PUBLICATION_FINALIZATION_INVALID");
    }
    await runWithDatabaseLease(this.#directory, async () => {
      const record = await this.#loadByReceipt(input.receiptId);
      if (record === null) throw new Error("APPROVAL_RECEIPT_INVALID");
      if (record.status === "consumed") {
        if (sameCanonical(record.finalization, input)) return;
        throw new Error("APPROVAL_RECEIPT_ALREADY_CONSUMED");
      }
      if (
        record.status !== "prepared" || record.artifact === null ||
        record.receipt.receipt_id !== input.receiptId ||
        record.candidate.candidate_id !== input.candidateId ||
        record.candidate.revision !== input.candidateRevision ||
        record.candidate.checksum !== input.candidateChecksum ||
        record.artifact.changeSet.change_set_id !== input.changeSetId ||
        record.artifact.changeSet.checksum !== input.changeSetChecksum
      ) {
        throw new Error("APPROVAL_RECORD_MISMATCH");
      }
      await this.#write(immutableCopy({
        ...record,
        status: "consumed" as const,
        finalization: input,
      }));
    });
  }

  async #loadByReceipt(receiptId: string): Promise<ApprovalRecord | null> {
    assertReceiptId(receiptId);
    try {
      const parsed = JSON.parse(
        await readFile(join(this.#directory, `${receiptId}.json`), "utf8"),
      ) as unknown;
      return this.#validate(parsed, receiptId);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  async #write(record: ApprovalRecord): Promise<void> {
    const validated = this.#validate(record, record.receipt.receipt_id);
    await writeProtectedJson(
      this.#directory,
      join(this.#directory, `${record.receipt.receipt_id}.json`),
      validated,
    );
  }

  #validate(value: unknown, receiptId: string): ApprovalRecord {
    if (typeof value !== "object" || value === null) throw new Error("APPROVAL_RECORD_INVALID");
    const record = value as Partial<ApprovalRecord>;
    if (
      record.schemaVersion !== "cognitive-runtime.approval-publication-record/v1" ||
      !["approved", "prepared", "consumed"].includes(record.status ?? "") ||
      record.receipt?.receipt_id !== receiptId ||
      record.candidate === undefined ||
      record.artifact === undefined ||
      record.finalization === undefined ||
      (record.status === "approved" && (record.artifact !== null || record.finalization !== null)) ||
      (record.status === "prepared" && (record.artifact === null || record.finalization !== null)) ||
      (record.status === "consumed" && (record.artifact === null || record.finalization === null))
    ) {
      throw new Error("APPROVAL_RECORD_INVALID");
    }
    assertValidContract("decision-receipt", record.receipt);
    assertValidContract("authority-candidate", record.candidate);
    if (
      record.receipt.decision === "rejected" ||
      record.receipt.candidate_id !== record.candidate.candidate_id ||
      record.receipt.candidate_revision !== record.candidate.revision ||
      record.receipt.candidate_checksum !== record.candidate.checksum ||
      record.receipt.base_authority_version !== record.candidate.base_authority_version
    ) {
      throw new Error("APPROVAL_RECORD_MISMATCH");
    }
    if (record.artifact !== null && record.artifact !== undefined) {
      const rebuilt = createChangeSet({
        candidate: record.candidate,
        approvalReceipt: record.receipt,
        operations: record.artifact.operations,
      });
      if (!sameCanonical(rebuilt, record.artifact)) throw new Error("APPROVAL_RECORD_TAMPERED");
    }
    if (record.finalization !== null && record.finalization !== undefined) {
      if (
        record.artifact === null || record.artifact === undefined ||
        record.finalization.receiptId !== record.receipt.receipt_id ||
        record.finalization.candidateId !== record.candidate.candidate_id ||
        record.finalization.candidateRevision !== record.candidate.revision ||
        record.finalization.candidateChecksum !== record.candidate.checksum ||
        record.finalization.changeSetId !== record.artifact.changeSet.change_set_id ||
        record.finalization.changeSetChecksum !== record.artifact.changeSet.checksum ||
        record.finalization.sourceRevision.length === 0
      ) {
        throw new Error("APPROVAL_RECORD_TAMPERED");
      }
    }
    return immutableCopy(record as ApprovalRecord);
  }
}

export class FilePublicationJournal implements PublicationJournalPort {
  readonly #directory: string;

  constructor(options: FilePublicationJournalOptions) {
    if (options.directory.length === 0) throw new Error("PUBLICATION_JOURNAL_DIRECTORY_REQUIRED");
    this.#directory = join(options.directory, "publication-journal");
  }

  async runExclusive<T>(changeSetId: string, operation: () => Promise<T>): Promise<T> {
    assertChangeSetId(changeSetId);
    return runWithDatabaseLease(this.#directory, operation);
  }

  async load(changeSetId: string): Promise<PublicationJournalRecord | null> {
    assertChangeSetId(changeSetId);
    try {
      const parsed = JSON.parse(
        await readFile(join(this.#directory, `${changeSetId}.json`), "utf8"),
      ) as unknown;
      return this.#validate(parsed, changeSetId);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  async write(record: PublicationJournalRecord): Promise<void> {
    const validated = this.#validate(record, record.changeSet.change_set_id);
    await writeProtectedJson(
      this.#directory,
      join(this.#directory, `${record.changeSet.change_set_id}.json`),
      validated,
    );
  }

  #validate(value: unknown, changeSetId: string): PublicationJournalRecord {
    assertChangeSetId(changeSetId);
    if (typeof value !== "object" || value === null) throw new Error("PUBLICATION_JOURNAL_INVALID");
    const record = value as Partial<PublicationJournalRecord>;
    if (
      record.schemaVersion !== "cognitive-runtime.publication-journal/v1" ||
      !["prepared", "committed", "completed"].includes(record.status ?? "") ||
      record.changeSet?.change_set_id !== changeSetId ||
      record.approvalReceiptId !== record.changeSet?.approval_receipt_id ||
      record.candidateChecksum !== record.changeSet?.candidate_checksum ||
      typeof record.expectedTreeChecksum !== "string" ||
      (record.status === "prepared" && record.commit !== null) ||
      (record.status !== "prepared" && (record.commit === null || record.commit === undefined))
    ) {
      throw new Error("PUBLICATION_JOURNAL_INVALID");
    }
    assertValidContract("change-set", record.changeSet);
    assertChecksum(record.expectedTreeChecksum, "PUBLICATION_JOURNAL_INVALID");
    if (record.commit !== null && record.commit !== undefined) {
      assertCommit(record.commit, record.changeSet, record.expectedTreeChecksum);
    }
    return immutableCopy(record as PublicationJournalRecord);
  }
}

const assertCommit = (
  commit: AuthorityPublicationCommit,
  changeSet: ChangeSet,
  expectedTreeChecksum: string,
): void => {
  if (
    commit.changeSetId !== changeSet.change_set_id ||
    commit.changeSetChecksum !== changeSet.checksum ||
    commit.commitId.length === 0 ||
    commit.sourceRevision !== commit.commitId ||
    commit.treeChecksum !== expectedTreeChecksum
  ) {
    throw new Error("PUBLICATION_COMMIT_MISMATCH");
  }
};

const assertPublicationValidation = (
  validation: AuthorityPublicationValidation,
): void => {
  if (
    validation.completeEntity !== true ||
    validation.baseMatches !== true ||
    validation.schemaValid !== true ||
    validation.referencesValid !== true ||
    validation.targetChecksumsValid !== true
  ) {
    throw new Error("PUBLICATION_VALIDATION_INCOMPLETE");
  }
  assertChecksum(validation.expectedTreeChecksum, "PUBLICATION_VALIDATION_INVALID");
};

const finalizationFor = (
  prepared: PreparedApprovalPublication,
  commit: AuthorityPublicationCommit,
): ApprovalPublicationFinalization => ({
  receiptId: prepared.receipt.receipt_id,
  candidateId: prepared.candidate.candidate_id,
  candidateRevision: prepared.candidate.revision,
  candidateChecksum: prepared.candidate.checksum,
  changeSetId: prepared.artifact.changeSet.change_set_id,
  changeSetChecksum: prepared.artifact.changeSet.checksum,
  sourceRevision: commit.sourceRevision,
});

const commitMetadataFor = (changeSet: ChangeSet): AuthorityCommitMetadata => ({
  subject: `authority: publish ${changeSet.change_set_id}`,
  trailers: {
    "Change-Set-ID": changeSet.change_set_id,
    "Change-Set-Checksum": changeSet.checksum,
    "Approval-Receipt-ID": changeSet.approval_receipt_id,
    "Candidate-ID": changeSet.candidate_id,
    "Candidate-Revision": String(changeSet.candidate_revision),
    "Candidate-Checksum": changeSet.candidate_checksum,
    "Base-Authority-Version": changeSet.base_authority_version ?? "none",
    "Base-Checksum": changeSet.base_checksum ?? "none",
  },
});

export interface ChangeSetPublicationCoordinatorOptions {
  readonly journal: PublicationJournalPort;
  readonly authority: AuthorityPublishingPort;
  readonly approvals: ApprovalPublicationPort;
  readonly failpoint?: (point: PublicationFailpoint) => void | Promise<void>;
  readonly lifecycle?: {
    recordLifecycle(outcome: "published" | "pending_activation"): void;
  };
}

export class ChangeSetPublicationCoordinator {
  readonly #journal: PublicationJournalPort;
  readonly #authority: AuthorityPublishingPort;
  readonly #approvals: ApprovalPublicationPort;
  readonly #failpoint: NonNullable<ChangeSetPublicationCoordinatorOptions["failpoint"]>;
  readonly #lifecycle: ChangeSetPublicationCoordinatorOptions["lifecycle"];

  constructor(options: ChangeSetPublicationCoordinatorOptions) {
    this.#journal = options.journal;
    this.#authority = options.authority;
    this.#approvals = options.approvals;
    this.#failpoint = options.failpoint ?? (() => {});
    this.#lifecycle = options.lifecycle;
  }

  async publish(input: {
    readonly candidate: AuthorityCandidate;
    readonly approvalReceipt: DecisionReceipt;
    readonly operations: readonly PublicationOperation[];
  }): Promise<PublicationResult> {
    const artifact = createChangeSet(input);
    return this.#journal.runExclusive(artifact.changeSet.change_set_id, async () => {
      const existing = await this.#journal.load(artifact.changeSet.change_set_id);
      if (existing !== null) {
        if (!sameCanonical(existing.changeSet, artifact.changeSet)) {
          throw new Error("PUBLICATION_CHANGE_SET_CONFLICT");
        }
        await this.#approvals.preparePublication({
          receipt: input.approvalReceipt,
          candidate: input.candidate,
          artifact,
        });
        await this.#inspectCheckout();
        return this.#resume(existing);
      }
      await this.#inspectCheckout();
      const validation = await this.#authority.validatePublication({
        changeSet: artifact.changeSet,
        candidate: input.candidate,
        operations: artifact.operations,
      });
      assertPublicationValidation(validation);
      await this.#approvals.preparePublication({
        receipt: input.approvalReceipt,
        candidate: input.candidate,
        artifact,
      });
      const prepared = immutableCopy({
        schemaVersion: "cognitive-runtime.publication-journal/v1" as const,
        status: "prepared" as const,
        approvalReceiptId: input.approvalReceipt.receipt_id,
        candidateChecksum: input.candidate.checksum,
        changeSet: artifact.changeSet,
        expectedTreeChecksum: validation.expectedTreeChecksum,
        commit: null,
      });
      await this.#journal.write(prepared);
      return this.#resume(prepared);
    });
  }

  async recover(changeSetId: string): Promise<PublicationResult> {
    return this.#journal.runExclusive(changeSetId, async () => {
      const record = await this.#journal.load(changeSetId);
      if (record === null) throw new Error("PUBLICATION_JOURNAL_NOT_FOUND");
      await this.#inspectCheckout();
      return this.#resume(record);
    });
  }

  async #inspectCheckout(): Promise<AuthorityCheckoutInspection> {
    const checkout = await this.#authority.inspectCheckout();
    if (checkout.kind !== "dedicated") throw new Error("AUTHORITY_CHECKOUT_NOT_DEDICATED");
    if (!checkout.clean) throw new Error("AUTHORITY_CHECKOUT_DIRTY");
    return checkout;
  }

  async #resume(initial: PublicationJournalRecord): Promise<PublicationResult> {
    let record = initial;
    const prepared = await this.#approvals.loadPreparedPublication(
      record.changeSet.change_set_id,
    );
    if (
      prepared === null ||
      prepared.receipt.receipt_id !== record.approvalReceiptId ||
      prepared.candidate.checksum !== record.candidateChecksum ||
      !sameCanonical(prepared.artifact.changeSet, record.changeSet)
    ) {
      throw new Error("PUBLICATION_APPROVAL_MISMATCH");
    }

    const foundCommit = await this.#authority.findCommit(record.changeSet);
    if (prepared.finalization !== null && foundCommit === null) {
      throw new Error("PUBLICATION_FINALIZATION_WITHOUT_COMMIT");
    }
    if (record.commit !== null) {
      if (foundCommit === null || !sameCanonical(foundCommit, record.commit)) {
        throw new Error("PUBLICATION_COMMIT_MISMATCH");
      }
      assertCommit(foundCommit, record.changeSet, record.expectedTreeChecksum);
    }
    let commit = record.commit ?? foundCommit;
    if (commit === null) {
      const validation = await this.#authority.validatePublication({
        changeSet: record.changeSet,
        candidate: prepared.candidate,
        operations: prepared.artifact.operations,
      });
      assertPublicationValidation(validation);
      if (validation.expectedTreeChecksum !== record.expectedTreeChecksum) {
        throw new Error("PUBLICATION_TARGET_TREE_DRIFT");
      }
      await this.#failpoint("before_authority_write");
      commit = await this.#authority.commitPublication({
        changeSet: record.changeSet,
        operations: prepared.artifact.operations,
        expectedTreeChecksum: record.expectedTreeChecksum,
        metadata: commitMetadataFor(record.changeSet),
      });
      assertCommit(commit, record.changeSet, record.expectedTreeChecksum);
      await this.#failpoint("after_git_commit");
    } else {
      assertCommit(commit, record.changeSet, record.expectedTreeChecksum);
    }
    if (record.commit === null) {
      record = immutableCopy({ ...record, status: "committed" as const, commit });
      await this.#journal.write(record);
    }

    const expectedFinalization = finalizationFor(prepared, commit);
    if (
      prepared.finalization !== null &&
      !sameCanonical(prepared.finalization, expectedFinalization)
    ) {
      throw new Error("PUBLICATION_FINALIZATION_MISMATCH");
    }
    if (prepared.finalization === null) {
      await this.#failpoint("before_receipt_finalization");
      await this.#approvals.finalizePublication(expectedFinalization);
    }
    if (record.status !== "completed") {
      record = immutableCopy({ ...record, status: "completed" as const, commit });
      await this.#journal.write(record);
    }
    const result = immutableCopy({
      changeSetId: record.changeSet.change_set_id,
      sourceRevision: commit.sourceRevision,
      publicationStatus: "Published" as const,
      activationStatus: "Pending Activation" as const,
    });
    this.#lifecycle?.recordLifecycle("published");
    this.#lifecycle?.recordLifecycle("pending_activation");
    return result;
  }
}
