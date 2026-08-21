import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  emptyCandidateAdmissionSnapshot,
  parseCandidateAdmissionSnapshot,
  type CandidateAdmissionPersistencePort,
  type CandidateAdmissionSnapshot,
} from "./index.js";
import type {
  AuthorityCandidate,
  DecisionReceipt,
} from "../contracts/index.js";
import { validateContract } from "../contracts/index.js";
import {
  canonicalJsonEqual,
  compareCanonicalStrings,
} from "../core/canonical-json.js";
import type {
  ApprovalPublicationFinalization,
  ApprovalPublicationPort,
  ChangeSetArtifact,
  PreparedApprovalPublication,
} from "../publication/index.js";

export interface FileCandidateAdmissionStoreOptions {
  readonly directory: string;
  readonly now?: () => Date;
}

export interface ApprovedCandidateRevision {
  readonly candidate: AuthorityCandidate;
  readonly receipt: DecisionReceipt;
}

const sameCanonical = canonicalJsonEqual;

const replaceReceipt = (
  snapshot: CandidateAdmissionSnapshot,
  receiptId: string,
  replacement: CandidateAdmissionSnapshot["receipts"][number],
): CandidateAdmissionSnapshot => ({
  ...snapshot,
  receipts: snapshot.receipts.map((record) =>
    record.receipt.receipt_id === receiptId ? replacement : record),
});

const assertPublicationContracts = (
  receipt: DecisionReceipt,
  candidate: AuthorityCandidate,
  artifact: ChangeSetArtifact,
): void => {
  if (
    !validateContract("decision-receipt", receipt).valid ||
    !validateContract("authority-candidate", candidate).valid ||
    !validateContract("change-set", artifact.changeSet).valid
  ) throw new Error("APPROVAL_PUBLICATION_RECORD_INVALID");
};

export class FileCandidateAdmissionStore
implements CandidateAdmissionPersistencePort, ApprovalPublicationPort {
  readonly #directory: string;
  readonly #databasePath: string;
  readonly #now: () => Date;

  constructor(options: FileCandidateAdmissionStoreOptions) {
    if (options.directory.length === 0) {
      throw new Error("CANDIDATE_ADMISSION_STORE_DIRECTORY_REQUIRED");
    }
    this.#directory = join(options.directory, "candidate-admission");
    this.#databasePath = join(this.#directory, "admission.sqlite");
    this.#now = options.now ?? (() => new Date());
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    chmodSync(this.#directory, 0o700);
    const database = this.#openDatabase();
    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS admission_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          snapshot TEXT NOT NULL
        );
      `);
      database.prepare(`
        INSERT OR IGNORE INTO admission_state (singleton, snapshot)
        VALUES (1, ?)
      `).run(JSON.stringify(emptyCandidateAdmissionSnapshot()));
    } finally {
      database.close();
    }
  }

  transact<T>(operation: (snapshot: unknown) => {
    readonly snapshot: CandidateAdmissionSnapshot;
    readonly result: T;
  }): T {
    const database = this.#openDatabase();
    database.exec("BEGIN IMMEDIATE");
    try {
      const row = database.prepare(
        "SELECT snapshot FROM admission_state WHERE singleton = 1",
      ).get() as { readonly snapshot?: unknown } | undefined;
      if (typeof row?.snapshot !== "string") {
        throw new Error("CANDIDATE_ADMISSION_STORE_INVALID");
      }
      let value: unknown;
      try {
        value = JSON.parse(row.snapshot);
      } catch {
        throw new Error("CANDIDATE_ADMISSION_STORE_INVALID");
      }
      const outcome = operation(value);
      const checked = parseCandidateAdmissionSnapshot(outcome.snapshot);
      database.prepare(
        "UPDATE admission_state SET snapshot = ? WHERE singleton = 1",
      ).run(JSON.stringify(checked));
      database.exec("COMMIT");
      return outcome.result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally {
      database.close();
    }
  }

  async preparePublication(input: {
    readonly receipt: DecisionReceipt;
    readonly candidate: AuthorityCandidate;
    readonly artifact: ChangeSetArtifact;
  }): Promise<void> {
    assertPublicationContracts(input.receipt, input.candidate, input.artifact);
    this.transact((stored) => {
      const snapshot = parseCandidateAdmissionSnapshot(stored);
      const record = snapshot.receipts.find((entry) =>
        entry.receipt.receipt_id === input.receipt.receipt_id);
      if (record === undefined || record.invalidated) {
        throw new Error("APPROVAL_RECEIPT_INVALID");
      }
      const candidate = snapshot.candidates
        .find((entry) => entry.candidateId === input.candidate.candidate_id)
        ?.revisions.find((entry) => entry.revision === input.candidate.revision);
      if (
        candidate === undefined ||
        record.receipt.decision === "rejected" ||
        !sameCanonical(record.receipt, input.receipt) ||
        !sameCanonical(candidate, input.candidate)
      ) throw new Error("APPROVAL_RECORD_MISMATCH");
      if (record.artifact !== null && !sameCanonical(record.artifact, input.artifact)) {
        throw new Error(record.consumed
          ? "APPROVAL_RECEIPT_ALREADY_CONSUMED"
          : "APPROVAL_RECEIPT_ALREADY_PREPARED");
      }
      if (record.artifact !== null) {
        return { snapshot, result: undefined };
      }
      const authorization = snapshot.authorizations.find((entry) =>
        entry.authorization_id === record.authorizationId);
      if (
        authorization === undefined ||
        authorization.status !== "active" ||
        Date.parse(authorization.expires_at) <= this.#now().getTime()
      ) throw new Error("APPROVAL_RECEIPT_INVALID");
      return {
        snapshot: replaceReceipt(snapshot, input.receipt.receipt_id, {
          ...record,
          artifact: input.artifact,
        }),
        result: undefined,
      };
    });
  }

  async loadApprovedCandidateRevision(
    candidateId: string,
    candidateRevision: number,
  ): Promise<ApprovedCandidateRevision> {
    return this.transact((stored) => {
      const snapshot = parseCandidateAdmissionSnapshot(stored);
      const record = snapshot.receipts.find((entry) =>
        entry.receipt.candidate_id === candidateId &&
        entry.receipt.candidate_revision === candidateRevision &&
        entry.receipt.decision !== "rejected" &&
        !entry.invalidated &&
        !entry.consumed);
      if (record === undefined) throw new Error("APPROVAL_RECEIPT_INVALID");
      if (record.artifact === null) {
        const authorization = snapshot.authorizations.find((entry) =>
          entry.authorization_id === record.authorizationId);
        if (
          authorization === undefined ||
          authorization.status !== "active" ||
          Date.parse(authorization.expires_at) <= this.#now().getTime()
        ) throw new Error("APPROVAL_RECEIPT_INVALID");
      }
      const candidate = snapshot.candidates
        .find((entry) => entry.candidateId === candidateId)
        ?.revisions.find((entry) => entry.revision === candidateRevision);
      if (
        candidate === undefined ||
        candidate.checksum !== record.receipt.candidate_checksum ||
        candidate.base_authority_version !== record.receipt.base_authority_version
      ) throw new Error("APPROVAL_RECORD_MISMATCH");
      return {
        snapshot,
        result: { candidate, receipt: record.receipt },
      };
    });
  }

  async listApprovedCandidateRevisions(
    instanceId: string,
  ): Promise<readonly ApprovedCandidateRevision[]> {
    return this.transact((stored) => {
      const snapshot = parseCandidateAdmissionSnapshot(stored);
      const results: ApprovedCandidateRevision[] = [];
      for (const record of snapshot.receipts) {
        const authorization = snapshot.authorizations.find((entry) =>
          entry.authorization_id === record.authorizationId);
        if (
          authorization?.instance_id !== instanceId ||
          record.receipt.decision === "rejected" ||
          record.invalidated ||
          record.consumed ||
          (record.artifact === null && (
            authorization.status !== "active" ||
            Date.parse(authorization.expires_at) <= this.#now().getTime()
          ))
        ) continue;
        const candidate = snapshot.candidates
          .find((entry) => entry.candidateId === record.receipt.candidate_id)
          ?.revisions.find((entry) => entry.revision === record.receipt.candidate_revision);
        if (
          candidate === undefined ||
          candidate.checksum !== record.receipt.candidate_checksum ||
          candidate.base_authority_version !== record.receipt.base_authority_version
        ) throw new Error("APPROVAL_RECORD_MISMATCH");
        results.push({ candidate, receipt: record.receipt });
      }
      results.sort((left, right) =>
        compareCanonicalStrings(left.receipt.receipt_id, right.receipt.receipt_id));
      return { snapshot, result: results };
    });
  }

  async loadPreparedPublication(
    changeSetId: string,
  ): Promise<PreparedApprovalPublication | null> {
    return this.transact((stored) => {
      const snapshot = parseCandidateAdmissionSnapshot(stored);
      const record = snapshot.receipts.find((entry) =>
        entry.artifact?.changeSet.change_set_id === changeSetId);
      if (record === undefined || record.artifact === null) {
        return { snapshot, result: null };
      }
      const candidate = snapshot.candidates
        .find((entry) => entry.candidateId === record.receipt.candidate_id)
        ?.revisions.find((entry) => entry.revision === record.receipt.candidate_revision);
      if (candidate === undefined) throw new Error("APPROVAL_RECORD_MISMATCH");
      return {
        snapshot,
        result: {
          receipt: record.receipt,
          candidate,
          artifact: record.artifact,
          finalization: record.finalization,
        },
      };
    });
  }

  async finalizePublication(input: ApprovalPublicationFinalization): Promise<void> {
    this.transact((stored) => {
      const snapshot = parseCandidateAdmissionSnapshot(stored);
      const record = snapshot.receipts.find((entry) =>
        entry.receipt.receipt_id === input.receiptId);
      if (record === undefined || record.invalidated || record.artifact === null) {
        throw new Error("APPROVAL_RECEIPT_INVALID");
      }
      const expected = {
        receiptId: record.receipt.receipt_id,
        candidateId: record.receipt.candidate_id,
        candidateRevision: record.receipt.candidate_revision,
        candidateChecksum: record.receipt.candidate_checksum,
        changeSetId: record.artifact.changeSet.change_set_id,
        changeSetChecksum: record.artifact.changeSet.checksum,
        sourceRevision: input.sourceRevision,
      } satisfies ApprovalPublicationFinalization;
      if (!sameCanonical(expected, input)) {
        throw new Error("APPROVAL_FINALIZATION_MISMATCH");
      }
      if (record.finalization !== null) {
        if (!sameCanonical(record.finalization, input)) {
          throw new Error("APPROVAL_RECEIPT_ALREADY_CONSUMED");
        }
        return { snapshot, result: undefined };
      }
      return {
        snapshot: replaceReceipt(snapshot, input.receiptId, {
          ...record,
          consumed: true,
          finalization: input,
        }),
        result: undefined,
      };
    });
  }

  #openDatabase(): DatabaseSync {
    const database = new DatabaseSync(this.#databasePath);
    chmodSync(this.#databasePath, 0o600);
    database.exec("PRAGMA busy_timeout = 300000");
    return database;
  }
}
