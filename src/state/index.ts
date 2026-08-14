import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  CurrentStateEvent,
  CurrentStateHead,
  ReanswerOutbox,
} from "../contracts/index.js";
import { validateContract } from "../contracts/index.js";
import {
  calculateStateViewChecksum,
  compareCanonicalStrings,
  stateViewVersion,
} from "./canonical.js";

export type ReanswerDeliveryMode =
  | "command_continuation"
  | "ui_normal_rpc";

export interface ReanswerAttempt {
  readonly successorRunId: string;
  readonly deliveryMode: ReanswerDeliveryMode;
}

export interface ReanswerClaim extends ReanswerAttempt {
  readonly correctionId: string;
  readonly attempt: number;
  readonly sessionKeyHash: string;
  readonly priorRunId: string;
  readonly newViewVersion: string;
}

export interface ReanswerPort<
  TClaim = ReanswerClaim,
  TCompletion = undefined,
> {
  claim(
    correctionId: string,
    attempt: ReanswerAttempt,
  ): Promise<TClaim | null>;
  complete(claim: TClaim, completion?: TCompletion): Promise<void>;
  release(claim: TClaim, reasonCode: string): Promise<void>;
}

export interface SessionReanswerPort<TClaim = ReanswerClaim> {
  claimForSession(
    sessionKeyHash: string,
    attempt: ReanswerAttempt,
  ): Promise<TClaim | null>;
}

export interface CorrectionInput {
  readonly event: CurrentStateEvent;
  readonly confirmation?: {
    readonly previewId: string;
    readonly previewChecksum: string;
    readonly receiptId?: string;
  };
  readonly outbox: {
    readonly correctionId: string;
    readonly instanceId: string;
    readonly sessionKeyHash: string;
    readonly priorRunId: string;
    readonly idempotencyKey: string;
    readonly createdAt: string;
  };
}

export interface SqliteStateStoreOptions {
  readonly databasePath: string;
  readonly instanceId?: string;
  readonly initialHead?: CurrentStateHead;
  readonly now?: () => string;
  readonly readOnly?: boolean;
}

export type SqliteReanswerStoreOptions = SqliteStateStoreOptions;

export interface StateViewRequest {
  readonly instanceId: string;
  readonly revision?: number;
}

export interface StateViewEntry {
  readonly stateId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly observedAt: string;
  readonly sourceKind: string;
  readonly sourceRef?: string;
}

export interface StateView {
  readonly instanceId: string;
  readonly revision: number;
  readonly viewVersion: string;
  readonly checksum: string;
  readonly states: readonly StateViewEntry[];
}

export interface StatePort<
  TViewRequest = StateViewRequest,
  TView = StateView,
  TCorrection = CorrectionInput,
  TReceipt = ReanswerOutbox,
> {
  view(request: TViewRequest): Promise<TView>;
  correct(input: TCorrection): Promise<TReceipt>;
}

export interface StateBaselineImportInput {
  readonly importId: string;
  readonly manifestChecksum: string;
  readonly initializedHeadChecksum: string;
  readonly events: readonly CurrentStateEvent[];
  readonly expectedHead: CurrentStateHead;
}

const schema = `
CREATE TABLE IF NOT EXISTS state_events (
  seq INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  state_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_ref TEXT,
  corrects_event_id TEXT,
  supersedes_event_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS state_head (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  active_seq INTEGER NOT NULL,
  view_version TEXT NOT NULL,
  checksum TEXT NOT NULL,
  activated_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS state_events_reject_update
  BEFORE UPDATE ON state_events
  BEGIN SELECT RAISE(ABORT, 'STATE_EVENTS_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS state_events_reject_delete
  BEFORE DELETE ON state_events
  BEGIN SELECT RAISE(ABORT, 'STATE_EVENTS_APPEND_ONLY'); END;
CREATE TABLE IF NOT EXISTS reanswer_outbox (
  correction_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  session_key_hash TEXT NOT NULL,
  prior_run_id TEXT NOT NULL,
  new_view_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_flight', 'completed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  successful_completion_count INTEGER NOT NULL DEFAULT 0 CHECK (successful_completion_count BETWEEN 0 AND 1),
  successor_run_id TEXT,
  delivery_mode TEXT CHECK (delivery_mode IN ('command_continuation', 'ui_normal_rpc')),
  last_error_code TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_reanswer_per_session
  ON reanswer_outbox(session_key_hash)
  WHERE status IN ('pending', 'in_flight');
CREATE UNIQUE INDEX IF NOT EXISTS runtime_state_events_idempotency
  ON state_events(idempotency_key);
`;

export const STATE_MANAGEMENT_TABLES_SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS state_correction_confirmations (
  correction_id TEXT PRIMARY KEY,
  preview_id TEXT NOT NULL,
  preview_checksum TEXT NOT NULL,
  receipt_id TEXT UNIQUE,
  FOREIGN KEY(correction_id) REFERENCES reanswer_outbox(correction_id)
);
CREATE TABLE IF NOT EXISTS state_imports (
  import_id TEXT PRIMARY KEY,
  manifest_checksum TEXT NOT NULL UNIQUE,
  initialized_head_checksum TEXT NOT NULL,
  final_head_checksum TEXT NOT NULL,
  imported_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS state_view_history (
  active_seq INTEGER PRIMARY KEY,
  view_version TEXT NOT NULL,
  checksum TEXT NOT NULL,
  activated_at TEXT NOT NULL
);
`;

export const applyStateManagementSchemaV2 = (
  database: DatabaseSync,
  appliedAt: string,
): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS runtime_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  database.exec(STATE_MANAGEMENT_TABLES_SCHEMA_V2);
  database.exec(`
    INSERT OR IGNORE INTO state_view_history(active_seq, view_version, checksum, activated_at)
    SELECT active_seq, view_version, checksum, activated_at FROM state_head WHERE singleton = 1
  `);
  database
    .prepare(
      "INSERT OR IGNORE INTO runtime_schema_migrations(version, name, applied_at) VALUES (2, 'state-management', ?)",
    )
    .run(appliedAt);
  database.exec("PRAGMA user_version = 2");
};

const migrateRuntimeDatabase = (database: DatabaseSync): void => {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS runtime_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const applied = database
      .prepare("SELECT 1 FROM runtime_schema_migrations WHERE version = 1")
      .get();
    if (applied === undefined) {
      database.exec(schema);
      database
        .prepare(
          "INSERT INTO runtime_schema_migrations(version, name, applied_at) VALUES (1, 'current-state-and-reanswer', ?)",
        )
        .run(new Date().toISOString());
    }
    const stateManagementApplied = database
      .prepare("SELECT 1 FROM runtime_schema_migrations WHERE version = 2")
      .get();
    if (stateManagementApplied === undefined) {
      applyStateManagementSchemaV2(database, new Date().toISOString());
    }
    database.exec("COMMIT");
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
};

export const runtimeDatabasePath = (
  stateRoot: string,
  instanceId: string,
): string => join(stateRoot, instanceId, "runtime.sqlite");

export const runtimeRestoreLockPath = (databasePath: string): string =>
  `${databasePath}.restore.lock`;

export const initializeRuntimeRunGuard = (database: DatabaseSync): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS runtime_served_runs (
      run_id TEXT PRIMARY KEY,
      served_at TEXT NOT NULL
    )
  `);
};

const recordServedRun = (
  database: DatabaseSync,
  databasePath: string,
  runId: string,
  servedAt: string,
): void => {
  if (runId.length === 0) {
    throw new Error("RUN_ID_REQUIRED");
  }
  if (existsSync(runtimeRestoreLockPath(databasePath))) {
    throw new Error("RUNTIME_RESTORE_IN_PROGRESS");
  }
  initializeRuntimeRunGuard(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    if (existsSync(runtimeRestoreLockPath(databasePath))) {
      throw new Error("RUNTIME_RESTORE_IN_PROGRESS");
    }
    database
      .prepare(
        "INSERT OR IGNORE INTO runtime_served_runs(run_id, served_at) VALUES (?, ?)",
      )
      .run(runId, servedAt);
    database.exec("COMMIT");
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
};

export const markRuntimeInstanceRunServed = (options: {
  readonly stateRoot: string;
  readonly instanceId: string;
  readonly runId: string;
  readonly servedAt?: string;
}): void => {
  const databasePath = runtimeDatabasePath(options.stateRoot, options.instanceId);
  const database = new DatabaseSync(databasePath);
  try {
    recordServedRun(
      database,
      databasePath,
      options.runId,
      options.servedAt ?? new Date().toISOString(),
    );
  } finally {
    database.close();
  }
};

const requireValidContract = (
  name: "current-state-event" | "current-state-head" | "reanswer-outbox",
  value: unknown,
): void => {
  if (!validateContract(name, value).valid) {
    throw new Error(`STATE_CONTRACT_INVALID:${name}`);
  }
};

const readString = (
  row: Readonly<Record<string, unknown>>,
  key: string,
): string => {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`SQLITE_ROW_INVALID:${key}`);
  }
  return value;
};

const readNumber = (
  row: Readonly<Record<string, unknown>>,
  key: string,
): number => {
  const value = row[key];
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`SQLITE_ROW_INVALID:${key}`);
  }
  return Number(value);
};

const optionalString = (
  row: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  const value = row[key];
  return typeof value === "string" ? value : undefined;
};

const checksumView = (
  instanceId: string,
  revision: number,
  states: readonly StateViewEntry[],
): string => {
  const values = states.map((entry) => ({
    state_id: entry.stateId,
    value: Object.hasOwn(entry.payload, "value") ? entry.payload.value : entry.payload,
    source_event_id: entry.eventId,
  }));
  return calculateStateViewChecksum(instanceId, revision, values);
};

const deepFreeze = <T>(value: T): Readonly<T> => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
};

export class SqliteStateStore
  implements
    StatePort,
    ReanswerPort<ReanswerClaim, undefined>,
    SessionReanswerPort<ReanswerClaim>
{
  readonly #database: DatabaseSync;
  readonly #databasePath: string;
  readonly #instanceId: string;
  readonly #now: () => string;

  constructor(options: SqliteStateStoreOptions) {
    if (options.initialHead !== undefined) {
      requireValidContract("current-state-head", options.initialHead);
    }
    const databaseExisted = options.databasePath === ":memory:" || existsSync(options.databasePath);
    this.#database = new DatabaseSync(options.databasePath, {
      readOnly: options.readOnly ?? false,
    });
    this.#databasePath = options.databasePath;
    this.#instanceId = options.instanceId ?? "instance-synthetic";
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#database.exec("PRAGMA busy_timeout = 5000");
    if (options.readOnly === true) {
      const head = this.#database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'state_head'",
        )
        .get();
      if (head === undefined) {
        this.#database.close();
        throw new Error("STATE_STORE_NOT_INITIALIZED");
      }
    } else {
      if (options.initialHead === undefined && !databaseExisted) {
        this.#database.close();
        throw new Error("STATE_INITIAL_HEAD_REQUIRED");
      }
      this.#database.exec("PRAGMA foreign_keys = ON");
      migrateRuntimeDatabase(this.#database);
      initializeRuntimeRunGuard(this.#database);
      if (options.initialHead !== undefined) {
        this.#database
          .prepare(
            "INSERT OR IGNORE INTO state_head(singleton, active_seq, view_version, checksum, activated_at) VALUES (1, ?, ?, ?, ?)",
          )
          .run(
            options.initialHead.active_seq,
            options.initialHead.view_version,
            options.initialHead.checksum,
            options.initialHead.activated_at,
          );
        this.#database
          .prepare(
            "INSERT OR IGNORE INTO state_view_history(active_seq, view_version, checksum, activated_at) VALUES (?, ?, ?, ?)",
          )
          .run(
            options.initialHead.active_seq,
            options.initialHead.view_version,
            options.initialHead.checksum,
            options.initialHead.activated_at,
          );
      } else if (this.#database.prepare("SELECT 1 FROM state_head WHERE singleton = 1").get() === undefined) {
        this.#database.close();
        throw new Error("STATE_HEAD_MISSING");
      }
    }
  }

  importBaseline(input: StateBaselineImportInput): boolean {
    input.events.forEach((event) => requireValidContract("current-state-event", event));
    requireValidContract("current-state-head", input.expectedHead);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existingImport = this.#database
        .prepare(
          "SELECT import_id, manifest_checksum FROM state_imports WHERE import_id = ? OR manifest_checksum = ? LIMIT 1",
        )
        .get(input.importId, input.manifestChecksum);
      if (existingImport !== undefined) {
        if (readString(existingImport, "import_id") !== input.importId ||
          readString(existingImport, "manifest_checksum") !== input.manifestChecksum) {
          throw new Error("STATE_IMPORT_IDEMPOTENCY_CONFLICT");
        }
        this.#database.exec("COMMIT");
        return false;
      }
      const head = this.getHead();
      const served = this.#database
        .prepare("SELECT 1 FROM runtime_served_runs LIMIT 1")
        .get();
      if (served !== undefined) {
        throw new Error("STATE_IMPORT_AFTER_FIRST_RUN");
      }
      if (head.active_seq !== 0 || this.getEventCount() !== 0 ||
        head.checksum !== input.initializedHeadChecksum) {
        throw new Error("STATE_IMPORT_REQUIRES_EMPTY_HEAD");
      }
      for (const event of input.events) {
        this.#database
          .prepare(
            `INSERT INTO state_events(
              seq, event_id, state_id, event_type, payload, observed_at, source_kind,
              source_ref, corrects_event_id, supersedes_event_id, idempotency_key, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            event.seq,
            event.event_id,
            event.state_id,
            event.event_type,
            JSON.stringify(event.payload),
            event.observed_at,
            event.source_kind,
            event.source_ref ?? null,
            event.corrects_event_id ?? null,
            event.supersedes_event_id ?? null,
            event.idempotency_key,
            event.created_at,
          );
      }
      for (const event of input.events) {
        const view = this.#reduceView(event.seq);
        this.#database
          .prepare(
            "INSERT INTO state_view_history(active_seq, view_version, checksum, activated_at) VALUES (?, ?, ?, ?)",
          )
          .run(
            view.revision,
            view.viewVersion,
            view.checksum,
            input.expectedHead.activated_at,
          );
      }
      const update = this.#database
        .prepare(
          "UPDATE state_head SET active_seq = ?, view_version = ?, checksum = ?, activated_at = ? WHERE singleton = 1 AND active_seq = 0",
        )
        .run(
          input.expectedHead.active_seq,
          input.expectedHead.view_version,
          input.expectedHead.checksum,
          input.expectedHead.activated_at,
        );
      if (Number(update.changes) !== 1) {
        throw new Error("STATE_HEAD_CAS_FAILED");
      }
      this.#database
        .prepare(
          "INSERT INTO state_imports(import_id, manifest_checksum, initialized_head_checksum, final_head_checksum, imported_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          input.importId,
          input.manifestChecksum,
          input.initializedHeadChecksum,
          input.expectedHead.checksum,
          input.expectedHead.activated_at,
        );
      this.#database
        .prepare(
          "INSERT OR IGNORE INTO state_view_history(active_seq, view_version, checksum, activated_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          input.expectedHead.active_seq,
          input.expectedHead.view_version,
          input.expectedHead.checksum,
          input.expectedHead.activated_at,
        );
      this.#database.exec("COMMIT");
      return true;
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async correct(input: CorrectionInput): Promise<ReanswerOutbox> {
    requireValidContract("current-state-event", input.event);
    if (input.outbox.instanceId !== this.#instanceId) {
      throw new Error("STATE_INSTANCE_MISMATCH");
    }

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.#getExisting(
        input.outbox.correctionId,
        input.outbox.idempotencyKey,
      );
      if (existing !== null) {
        this.#assertExistingConfirmation(input);
        this.#database.exec("COMMIT");
        return existing;
      }
      const sessionBusy = this.#database
        .prepare(
          "SELECT 1 AS busy FROM reanswer_outbox WHERE session_key_hash = ? AND status IN ('pending', 'in_flight') LIMIT 1",
        )
        .get(input.outbox.sessionKeyHash);
      if (sessionBusy !== undefined) {
        throw new Error("REANSWER_SESSION_BUSY");
      }
      const headRow = this.#database
        .prepare("SELECT active_seq FROM state_head WHERE singleton = 1")
        .get();
      if (
        headRow === undefined ||
        readNumber(headRow, "active_seq") + 1 !== input.event.seq
      ) {
        throw new Error("STATE_HEAD_CAS_FAILED");
      }
      const previousActiveSeq = input.event.seq - 1;

      this.#database
        .prepare(
          `INSERT INTO state_events(
            seq, event_id, state_id, event_type, payload, observed_at, source_kind,
            source_ref, corrects_event_id, supersedes_event_id, idempotency_key, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.event.seq,
          input.event.event_id,
          input.event.state_id,
          input.event.event_type,
          JSON.stringify(input.event.payload),
          input.event.observed_at,
          input.event.source_kind,
          input.event.source_ref ?? null,
          input.event.corrects_event_id ?? null,
          input.event.supersedes_event_id ?? null,
          input.event.idempotency_key,
          input.event.created_at,
        );
      const nextView = this.#reduceView(input.event.seq);
      const nextHead: CurrentStateHead = {
        active_seq: nextView.revision,
        view_version: nextView.viewVersion,
        checksum: nextView.checksum,
        activated_at: input.outbox.createdAt,
      };
      requireValidContract("current-state-head", nextHead);
      const outbox: ReanswerOutbox = {
        correction_id: input.outbox.correctionId,
        instance_id: input.outbox.instanceId,
        session_key_hash: input.outbox.sessionKeyHash,
        prior_run_id: input.outbox.priorRunId,
        new_view_version: nextHead.view_version,
        status: "pending",
        attempt_count: 0,
        successful_completion_count: 0,
        idempotency_key: input.outbox.idempotencyKey,
        created_at: input.outbox.createdAt,
        updated_at: input.outbox.createdAt,
      };
      requireValidContract("reanswer-outbox", outbox);
      const headUpdate = this.#database
        .prepare(
          "UPDATE state_head SET active_seq = ?, view_version = ?, checksum = ?, activated_at = ? WHERE singleton = 1 AND active_seq = ?",
        )
        .run(
          nextHead.active_seq,
          nextHead.view_version,
          nextHead.checksum,
          nextHead.activated_at,
          previousActiveSeq,
        );
      if (Number(headUpdate.changes) !== 1) {
        throw new Error("STATE_HEAD_CAS_FAILED");
      }
      this.#database
        .prepare(
          "INSERT INTO state_view_history(active_seq, view_version, checksum, activated_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          nextHead.active_seq,
          nextHead.view_version,
          nextHead.checksum,
          nextHead.activated_at,
        );
      this.#database
        .prepare(
          `INSERT INTO reanswer_outbox(
            correction_id, instance_id, session_key_hash, prior_run_id,
            new_view_version, status, attempt_count, successful_completion_count,
            idempotency_key, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?, ?)`,
        )
        .run(
          outbox.correction_id,
          outbox.instance_id,
          outbox.session_key_hash,
          outbox.prior_run_id,
          outbox.new_view_version,
          outbox.idempotency_key,
          outbox.created_at,
          outbox.updated_at,
        );
      if (input.confirmation !== undefined) {
        this.#database
          .prepare(
            "INSERT INTO state_correction_confirmations(correction_id, preview_id, preview_checksum, receipt_id) VALUES (?, ?, ?, ?)",
          )
          .run(
            outbox.correction_id,
            input.confirmation.previewId,
            input.confirmation.previewChecksum,
            input.confirmation.receiptId ?? null,
          );
      }
      this.#database.exec("COMMIT");
      return outbox;
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async view(request: StateViewRequest): Promise<StateView> {
    if (request.instanceId !== this.#instanceId) {
      throw new Error("STATE_INSTANCE_MISMATCH");
    }
    const head = this.getHead();
    const revision = request.revision ?? head.active_seq;
    if (!Number.isInteger(revision) || revision < 0 || revision > head.active_seq) {
      throw new Error(`STATE_REVISION_NOT_FOUND:${revision}`);
    }
    return this.#reduceView(revision);
  }

  async claim(
    correctionId: string,
    attempt: ReanswerAttempt,
  ): Promise<ReanswerClaim | null> {
    this.#assertDistinctSuccessor(
      "correction_id = ?",
      correctionId,
      attempt.successorRunId,
    );
    const row = this.#database
      .prepare(
        `UPDATE reanswer_outbox
         SET status = 'in_flight', attempt_count = attempt_count + 1,
             successor_run_id = ?, delivery_mode = ?, last_error_code = NULL,
             updated_at = ?
         WHERE correction_id = ? AND status = 'pending'
         RETURNING attempt_count, session_key_hash, prior_run_id, new_view_version`,
      )
      .get(
        attempt.successorRunId,
        attempt.deliveryMode,
        this.#now(),
        correctionId,
      );
    if (row === undefined) {
      return null;
    }
    return {
      correctionId,
      successorRunId: attempt.successorRunId,
      deliveryMode: attempt.deliveryMode,
      attempt: readNumber(row, "attempt_count"),
      sessionKeyHash: readString(row, "session_key_hash"),
      priorRunId: readString(row, "prior_run_id"),
      newViewVersion: readString(row, "new_view_version"),
    };
  }

  async claimForSession(
    sessionKeyHash: string,
    attempt: ReanswerAttempt,
  ): Promise<ReanswerClaim | null> {
    const pending = this.#database
      .prepare(
        "SELECT correction_id FROM reanswer_outbox WHERE session_key_hash = ? AND status = 'pending'",
      )
      .get(sessionKeyHash);
    if (pending === undefined) {
      return null;
    }
    return this.claim(readString(pending, "correction_id"), attempt);
  }

  async complete(claim: ReanswerClaim): Promise<void> {
    const result = this.#database
      .prepare(
        `UPDATE reanswer_outbox
         SET status = 'completed', successful_completion_count = 1,
             updated_at = ?
         WHERE correction_id = ? AND status = 'in_flight'
           AND attempt_count = ? AND successor_run_id = ?
           AND delivery_mode = ? AND successful_completion_count = 0`,
      )
      .run(
        this.#now(),
        claim.correctionId,
        claim.attempt,
        claim.successorRunId,
        claim.deliveryMode,
      );
    if (Number(result.changes) !== 1) {
      throw new Error(`REANSWER_CAS_FAILED:${claim.correctionId}`);
    }
  }

  async release(claim: ReanswerClaim, reasonCode: string): Promise<void> {
    if (!/^[A-Z][A-Z0-9_]*$/.test(reasonCode)) {
      throw new Error("REANSWER_REASON_CODE_INVALID");
    }
    const result = this.#database
      .prepare(
        `UPDATE reanswer_outbox
         SET status = 'pending', successor_run_id = NULL, delivery_mode = NULL,
             last_error_code = ?, updated_at = ?
         WHERE correction_id = ? AND status = 'in_flight'
           AND attempt_count = ? AND successor_run_id = ? AND delivery_mode = ?`,
      )
      .run(
        reasonCode,
        this.#now(),
        claim.correctionId,
        claim.attempt,
        claim.successorRunId,
        claim.deliveryMode,
      );
    if (Number(result.changes) !== 1) {
      throw new Error(`REANSWER_CAS_FAILED:${claim.correctionId}`);
    }
  }

  get(correctionId: string): ReanswerOutbox | null {
    const row = this.#database
      .prepare("SELECT * FROM reanswer_outbox WHERE correction_id = ?")
      .get(correctionId);
    return row === undefined ? null : this.#toOutbox(row);
  }

  getHead(): CurrentStateHead {
    const row = this.#database
      .prepare("SELECT active_seq, view_version, checksum, activated_at FROM state_head WHERE singleton = 1")
      .get();
    if (row === undefined) {
      throw new Error("STATE_HEAD_MISSING");
    }
    return {
      active_seq: readNumber(row, "active_seq"),
      view_version: readString(row, "view_version"),
      checksum: readString(row, "checksum"),
      activated_at: readString(row, "activated_at"),
    };
  }

  getEventCount(): number {
    const row = this.#database.prepare("SELECT count(*) AS count FROM state_events").get();
    return row === undefined ? 0 : readNumber(row, "count");
  }

  getViewActivatedAt(revision: number): string {
    const history = this.#database
      .prepare("SELECT activated_at FROM state_view_history WHERE active_seq = ?")
      .get(revision);
    if (history !== undefined) {
      return readString(history, "activated_at");
    }
    throw new Error(`STATE_VIEW_HISTORY_MISSING:${revision}`);
  }

  markRunServed(runId: string): void {
    recordServedRun(this.#database, this.#databasePath, runId, this.#now());
  }

  close(): void {
    this.#database.close();
  }

  #getExisting(correctionId: string, idempotencyKey: string): ReanswerOutbox | null {
    const row = this.#database
      .prepare(
        "SELECT * FROM reanswer_outbox WHERE correction_id = ? OR idempotency_key = ? LIMIT 1",
      )
      .get(correctionId, idempotencyKey);
    return row === undefined ? null : this.#toOutbox(row);
  }

  #assertExistingConfirmation(input: CorrectionInput): void {
    if (input.confirmation === undefined) {
      return;
    }
    const row = this.#database
      .prepare(
        "SELECT preview_id, preview_checksum, receipt_id FROM state_correction_confirmations WHERE correction_id = ?",
      )
      .get(input.outbox.correctionId);
    if (row === undefined ||
      readString(row, "preview_id") !== input.confirmation.previewId ||
      readString(row, "preview_checksum") !== input.confirmation.previewChecksum ||
      optionalString(row, "receipt_id") !== input.confirmation.receiptId) {
      throw new Error("STATE_CORRECTION_IDEMPOTENCY_CONFLICT");
    }
  }

  #toOutbox(row: Readonly<Record<string, unknown>>): ReanswerOutbox {
    const status = readString(row, "status");
    if (status !== "pending" && status !== "in_flight" && status !== "completed") {
      throw new Error("SQLITE_ROW_INVALID:status");
    }
    const successorRunId = optionalString(row, "successor_run_id");
    const lastErrorCode = optionalString(row, "last_error_code");
    return {
      correction_id: readString(row, "correction_id"),
      instance_id: readString(row, "instance_id"),
      session_key_hash: readString(row, "session_key_hash"),
      prior_run_id: readString(row, "prior_run_id"),
      new_view_version: readString(row, "new_view_version"),
      status,
      attempt_count: readNumber(row, "attempt_count"),
      successful_completion_count: readNumber(row, "successful_completion_count"),
      ...(successorRunId === undefined ? {} : { successor_run_id: successorRunId }),
      ...(lastErrorCode === undefined ? {} : { last_error_code: lastErrorCode }),
      idempotency_key: readString(row, "idempotency_key"),
      created_at: readString(row, "created_at"),
      updated_at: readString(row, "updated_at"),
    };
  }

  #assertDistinctSuccessor(
    selector: "correction_id = ?",
    selectorValue: string,
    successorRunId: string,
  ): void {
    const row = this.#database
      .prepare(
        `SELECT prior_run_id FROM reanswer_outbox WHERE ${selector} AND status = 'pending'`,
      )
      .get(selectorValue);
    if (
      row !== undefined &&
      readString(row, "prior_run_id") === successorRunId
    ) {
      throw new Error("REANSWER_SUCCESSOR_RUN_NOT_DISTINCT");
    }
  }

  #reduceView(revision: number): StateView {
    const rows = this.#database
      .prepare(
        "SELECT * FROM state_events WHERE seq <= ? ORDER BY seq, event_id",
      )
      .all(revision);
    const current = new Map<string, StateViewEntry>();
    for (const row of rows) {
      const payload: unknown = JSON.parse(readString(row, "payload"));
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new Error("STATE_EVENT_PAYLOAD_INVALID");
      }
      const sourceRef = optionalString(row, "source_ref");
      current.set(readString(row, "state_id"), {
        stateId: readString(row, "state_id"),
        eventId: readString(row, "event_id"),
        eventType: readString(row, "event_type"),
        payload: payload as Readonly<Record<string, unknown>>,
        observedAt: readString(row, "observed_at"),
        sourceKind: readString(row, "source_kind"),
        ...(sourceRef === undefined ? {} : { sourceRef }),
      });
    }
    const states = [...current.values()].sort((left, right) =>
      compareCanonicalStrings(left.stateId, right.stateId));
    const checksum = checksumView(this.#instanceId, revision, states);
    const view: StateView = {
      instanceId: this.#instanceId,
      revision,
      viewVersion: stateViewVersion(revision, checksum),
      checksum,
      states,
    };
    return deepFreeze(structuredClone(view));
  }
}

export class SqliteReanswerStore extends SqliteStateStore {}
