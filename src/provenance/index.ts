import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { CognitiveProvenanceOverlay } from "../contracts/index.js";
import { validateContract } from "../contracts/index.js";
import { canonicalJson } from "../core/canonical-json.js";

export interface ProvenanceQuery {
  readonly runId?: string;
  readonly sessionKeyHash?: string;
  readonly traceStatus?: string;
  readonly stableRef?: string;
  readonly limit?: number;
}

export interface ProvenancePort<
  TOverlay = CognitiveProvenanceOverlay,
  TQuery = ProvenanceQuery,
> {
  record(overlay: TOverlay): Promise<TOverlay>;
  get(traceId: string): Promise<TOverlay | null>;
  query(query: TQuery): Promise<readonly TOverlay[]>;
}

export interface SqliteProvenanceStoreOptions {
  readonly databasePath: string;
  readonly readOnly?: boolean;
}

const schema = `
CREATE TABLE cognitive_provenance_overlay (
  trace_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  session_key_hash TEXT NOT NULL,
  sync_generation TEXT NOT NULL,
  state_view_version TEXT NOT NULL,
  trace_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX cognitive_provenance_session_created
  ON cognitive_provenance_overlay(session_key_hash, created_at DESC);
CREATE INDEX cognitive_provenance_status_created
  ON cognitive_provenance_overlay(trace_status, created_at DESC);
`;

const migrate = (database: DatabaseSync): void => {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE provenance_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      ${schema}
    `);
    database
      .prepare(
        "INSERT INTO provenance_schema_migrations(version, name, applied_at) VALUES (1, 'minimal-cognitive-overlay', ?)",
      )
      .run(new Date().toISOString());
    database.exec("PRAGMA user_version = 1");
    database.exec("COMMIT");
  } catch (error: unknown) {
    database.exec("ROLLBACK");
    throw error;
  }
};

const initialize = (database: DatabaseSync): void => {
  const migrations = database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provenance_schema_migrations'",
    )
    .get();
  if (migrations === undefined) {
    migrate(database);
    return;
  }
  const version = database.prepare("PRAGMA user_version").get();
  if (version?.user_version !== 1) {
    throw new Error("PROVENANCE_SCHEMA_VERSION_UNSUPPORTED");
  }
};

const serialize = canonicalJson;

const deepFreeze = <T>(value: T): Readonly<T> => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
};

const readOverlay = (
  row: Readonly<Record<string, unknown>>,
): CognitiveProvenanceOverlay => {
  if (typeof row.payload !== "string") {
    throw new Error("PROVENANCE_ROW_INVALID");
  }
  const parsed: unknown = JSON.parse(row.payload);
  if (!validateContract("cognitive-provenance-overlay", parsed).valid) {
    throw new Error("PROVENANCE_ROW_INVALID");
  }
  return deepFreeze(
    structuredClone(parsed as CognitiveProvenanceOverlay),
  );
};

export const provenanceDatabasePath = (
  stateRoot: string,
  instanceId: string,
): string => join(stateRoot, instanceId, "provenance.sqlite");

export class SqliteProvenanceStore implements ProvenancePort {
  readonly #database: DatabaseSync;
  readonly #readOnly: boolean;

  constructor(options: SqliteProvenanceStoreOptions) {
    this.#readOnly = options.readOnly ?? false;
    this.#database = new DatabaseSync(options.databasePath, {
      readOnly: this.#readOnly,
    });
    if (this.#readOnly) {
      const table = this.#database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cognitive_provenance_overlay'",
        )
        .get();
      if (table === undefined) {
        this.#database.close();
        throw new Error("PROVENANCE_STORE_NOT_INITIALIZED");
      }
      const version = this.#database.prepare("PRAGMA user_version").get();
      if (version?.user_version !== 1) {
        this.#database.close();
        throw new Error("PROVENANCE_SCHEMA_VERSION_UNSUPPORTED");
      }
    } else {
      initialize(this.#database);
    }
  }

  async record(
    overlay: CognitiveProvenanceOverlay,
  ): Promise<CognitiveProvenanceOverlay> {
    if (this.#readOnly) {
      throw new Error("PROVENANCE_READ_ONLY");
    }
    if (!validateContract("cognitive-provenance-overlay", overlay).valid) {
      throw new Error("PROVENANCE_CONTRACT_INVALID");
    }
    if (overlay.validated_router_result !== null) {
      throw new Error("PROVENANCE_ROUTER_RESULT_NOT_MINIMAL");
    }
    const encoded = serialize(overlay);
    const existingTrace = this.#database
      .prepare(
        "SELECT payload FROM cognitive_provenance_overlay WHERE trace_id = ?",
      )
      .get(overlay.trace_id);
    if (existingTrace !== undefined) {
      if (existingTrace.payload !== encoded) {
        throw new Error("PROVENANCE_TRACE_CONFLICT");
      }
      return readOverlay(existingTrace);
    }
    const existingRun = this.#database
      .prepare(
        "SELECT trace_id FROM cognitive_provenance_overlay WHERE run_id = ?",
      )
      .get(overlay.run_id);
    if (existingRun !== undefined) {
      throw new Error("PROVENANCE_RUN_CONFLICT");
    }
    this.#database
      .prepare(
        `INSERT INTO cognitive_provenance_overlay(
          trace_id, run_id, session_key_hash, sync_generation,
          state_view_version, trace_status, created_at, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        overlay.trace_id,
        overlay.run_id,
        overlay.session_key_hash,
        overlay.sync_generation,
        overlay.state_view_version,
        overlay.trace_status,
        overlay.created_at,
        encoded,
      );
    return readOverlay({ payload: encoded });
  }

  async get(traceId: string): Promise<CognitiveProvenanceOverlay | null> {
    const row = this.#database
      .prepare(
        "SELECT payload FROM cognitive_provenance_overlay WHERE trace_id = ?",
      )
      .get(traceId);
    return row === undefined ? null : readOverlay(row);
  }

  async query(
    query: ProvenanceQuery,
  ): Promise<readonly CognitiveProvenanceOverlay[]> {
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("PROVENANCE_QUERY_LIMIT_INVALID");
    }
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (query.runId !== undefined) {
      clauses.push("run_id = ?");
      parameters.push(query.runId);
    }
    if (query.sessionKeyHash !== undefined) {
      clauses.push("session_key_hash = ?");
      parameters.push(query.sessionKeyHash);
    }
    if (query.traceStatus !== undefined) {
      clauses.push("trace_status = ?");
      parameters.push(query.traceStatus);
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const rows = this.#database
      .prepare(
        `SELECT payload FROM cognitive_provenance_overlay ${where}
         ORDER BY created_at DESC, trace_id DESC`,
      )
      .all(...parameters)
      .map(readOverlay);
    const filtered = query.stableRef === undefined
      ? rows
      : rows.filter((overlay) =>
          [...overlay.cognitive_bindings, ...overlay.stable_refs]
            .some((reference) => reference.id === query.stableRef)
        );
    return deepFreeze(filtered.slice(0, limit));
  }

  close(): void {
    this.#database.close();
  }
}
