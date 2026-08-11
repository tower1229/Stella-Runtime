import { DatabaseSync } from "node:sqlite";

import type {
  CurrentStateEvent,
  CurrentStateHead,
  ReanswerOutbox,
} from "../contracts/index.js";
import { validateContract } from "../contracts/index.js";

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

export interface CorrectionInput {
  readonly event: CurrentStateEvent;
  readonly newHead: CurrentStateHead;
  readonly outbox: {
    readonly correctionId: string;
    readonly instanceId: string;
    readonly sessionKeyHash: string;
    readonly priorRunId: string;
    readonly idempotencyKey: string;
    readonly createdAt: string;
  };
}

export interface SqliteReanswerStoreOptions {
  readonly databasePath: string;
  readonly initialHead: CurrentStateHead;
  readonly now?: () => string;
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
`;

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

export class SqliteReanswerStore
  implements ReanswerPort<ReanswerClaim, undefined>
{
  readonly #database: DatabaseSync;
  readonly #now: () => string;

  constructor(options: SqliteReanswerStoreOptions) {
    requireValidContract("current-state-head", options.initialHead);
    this.#database = new DatabaseSync(options.databasePath);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec(schema);
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
  }

  async correct(input: CorrectionInput): Promise<ReanswerOutbox> {
    const existing = this.#getExisting(
      input.outbox.correctionId,
      input.outbox.idempotencyKey,
    );
    if (existing !== null) {
      return existing;
    }
    requireValidContract("current-state-event", input.event);
    requireValidContract("current-state-head", input.newHead);
    if (input.event.seq !== input.newHead.active_seq) {
      throw new Error("STATE_HEAD_BOUNDARY_MISMATCH");
    }

    const outbox: ReanswerOutbox = {
      schema_version: "cognitive-runtime.reanswer-outbox/v1",
      correction_id: input.outbox.correctionId,
      instance_id: input.outbox.instanceId,
      session_key_hash: input.outbox.sessionKeyHash,
      prior_run_id: input.outbox.priorRunId,
      new_view_version: input.newHead.view_version,
      status: "pending",
      attempt_count: 0,
      successful_completion_count: 0,
      idempotency_key: input.outbox.idempotencyKey,
      created_at: input.outbox.createdAt,
      updated_at: input.outbox.createdAt,
    };
    requireValidContract("reanswer-outbox", outbox);

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const sessionBusy = this.#database
        .prepare(
          "SELECT 1 AS busy FROM reanswer_outbox WHERE session_key_hash = ? AND status IN ('pending', 'in_flight') LIMIT 1",
        )
        .get(input.outbox.sessionKeyHash);
      if (sessionBusy !== undefined) {
        throw new Error("REANSWER_SESSION_BUSY");
      }

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
      this.#database
        .prepare(
          "UPDATE state_head SET active_seq = ?, view_version = ?, checksum = ?, activated_at = ? WHERE singleton = 1",
        )
        .run(
          input.newHead.active_seq,
          input.newHead.view_version,
          input.newHead.checksum,
          input.newHead.activated_at,
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
      this.#database.exec("COMMIT");
      return outbox;
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async claim(
    correctionId: string,
    attempt: ReanswerAttempt,
  ): Promise<ReanswerClaim | null> {
    const row = this.#database
      .prepare(
        `UPDATE reanswer_outbox
         SET status = 'in_flight', attempt_count = attempt_count + 1,
             successor_run_id = ?, delivery_mode = ?, last_error_code = NULL,
             updated_at = ?
         WHERE correction_id = ? AND status = 'pending'
         RETURNING attempt_count`,
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
    };
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
      schema_version: "cognitive-runtime.current-state-head/v1",
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

  #toOutbox(row: Readonly<Record<string, unknown>>): ReanswerOutbox {
    const status = readString(row, "status");
    if (status !== "pending" && status !== "in_flight" && status !== "completed") {
      throw new Error("SQLITE_ROW_INVALID:status");
    }
    const successorRunId = optionalString(row, "successor_run_id");
    const lastErrorCode = optionalString(row, "last_error_code");
    return {
      schema_version: "cognitive-runtime.reanswer-outbox/v1",
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
}
