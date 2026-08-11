import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  RuntimeRecoverySnapshotManifest,
  RuntimeRecoveryVerificationOrRestoreReport,
} from "../contracts/index.js";
import { validateContract } from "../contracts/index.js";

export const AUTHORITATIVE_SNAPSHOT_CONTENTS = [
  "current_state_event_ledger",
  "active_state_head",
  "unfinished_corrections",
  "reanswer_outbox",
  "storage_schema_version",
] as const;

export const EXCLUDED_SNAPSHOT_CONTENTS = [
  "state_view",
  "generation",
  "registry",
  "index",
  "cache",
  "credentials",
  "cognitive_provenance_overlay",
  "logs",
  "raw_experience_records",
  "authority_documents",
] as const;

const SNAPSHOT_SCHEMA_VERSION =
  "cognitive-runtime.runtime-recovery-snapshot-manifest/v1" as const;
const REPORT_SCHEMA_VERSION =
  "cognitive-runtime.runtime-recovery-report/v1" as const;
const CONTRACT_VERSION = "v1" as const;
const SNAPSHOT_DATABASE_PATH = "authoritative/state.sqlite";
const ARTIFACT_ID_PATH = "artifact.sha256";
const PROJECTIONS_REQUIRING_REBUILD = [
  "state_view",
  "generation",
  "registry",
  "index",
  "cache",
] as const;
const instanceIdPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;

const portableSchema = `
CREATE TABLE state_events (
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
CREATE TABLE state_head (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  active_seq INTEGER NOT NULL,
  view_version TEXT NOT NULL,
  checksum TEXT NOT NULL,
  activated_at TEXT NOT NULL
);
CREATE TRIGGER state_events_reject_update
  BEFORE UPDATE ON state_events
  BEGIN SELECT RAISE(ABORT, 'STATE_EVENTS_APPEND_ONLY'); END;
CREATE TRIGGER state_events_reject_delete
  BEFORE DELETE ON state_events
  BEGIN SELECT RAISE(ABORT, 'STATE_EVENTS_APPEND_ONLY'); END;
CREATE TABLE reanswer_outbox (
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
CREATE UNIQUE INDEX one_open_reanswer_per_session
  ON reanswer_outbox(session_key_hash)
  WHERE status IN ('pending', 'in_flight');
`;

export interface RuntimeRecoverySnapshot {
  readonly artifactId: string;
  readonly directory: string;
  readonly manifest: RuntimeRecoverySnapshotManifest;
}

export interface RuntimeBackupOptions {
  readonly instanceId: string;
  readonly authorityRevision: string;
  readonly outputDirectory: string;
  readonly consistency: "transactional_boundary";
}

export interface RuntimeVerifyOptions {
  readonly expectedInstanceId?: string;
  readonly supportedSnapshotSchemaVersions: readonly string[];
  readonly supportedStorageSchemaVersions: readonly string[];
  readonly supportedPackageVersions: readonly string[];
  readonly supportedContractVersions: readonly string[];
  readonly access: "read_only";
}

export interface RuntimeRestoreOptions
  extends Omit<RuntimeVerifyOptions, "access" | "expectedInstanceId"> {
  readonly targetInstanceId: string;
  readonly targetHasServedRun: boolean;
  readonly restoreIdempotencyKey: string;
  readonly rollback: "required";
  readonly signal?: Pick<AbortSignal, "aborted">;
}

export interface RuntimeRecoveryStorageOptions {
  readonly stateRoot: string;
  readonly packageVersion: string;
  readonly storageSchemaVersion: string;
  readonly now?: () => string;
}

export interface RuntimeRecoveryPort<
  TBackupOptions = RuntimeBackupOptions,
  TVerifyOptions = RuntimeVerifyOptions,
  TRestoreOptions = RuntimeRestoreOptions,
  TSnapshot = RuntimeRecoverySnapshot,
  TReport = RuntimeRecoveryVerificationOrRestoreReport,
> {
  backup(options: TBackupOptions): Promise<TSnapshot>;
  verify(snapshot: TSnapshot, options: TVerifyOptions): Promise<TReport>;
  restore(snapshot: TSnapshot, options: TRestoreOptions): Promise<TReport>;
}

type Row = Readonly<Record<string, unknown>>;

interface SnapshotState {
  readonly activeHead: {
    readonly activeSeq: number;
    readonly viewVersion: string;
    readonly checksum: string;
  };
  readonly pendingCount: number;
  readonly inFlightCount: number;
}

const sha256 = (value: string | Uint8Array): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const toRows = (rows: readonly object[]): readonly Row[] => rows as readonly Row[];

const toSqlValue = (
  value: unknown,
): string | number | bigint | Uint8Array | null => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  throw new Error("SNAPSHOT_ROW_INVALID:sql_value");
};

const isAborted = (
  signal: Pick<AbortSignal, "aborted"> | undefined,
): boolean => signal?.aborted === true;

const readString = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`SNAPSHOT_ROW_INVALID:${key}`);
  }
  return value;
};

const readNumber = (row: Row, key: string): number => {
  const value = row[key];
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`SNAPSHOT_ROW_INVALID:${key}`);
  }
  return Number(value);
};

const checkResult = (
  reasonCodes: readonly string[],
): { readonly status: "pass" | "fail"; readonly reason_codes: string[] } => ({
  status: reasonCodes.length === 0 ? "pass" : "fail",
  reason_codes: [...new Set(reasonCodes)],
});

const emptyReport = (
  operation: "verify" | "restore",
  compatibilityReasons: readonly string[],
  integrityReasons: readonly string[],
): RuntimeRecoveryVerificationOrRestoreReport => ({
  report_schema_version: REPORT_SCHEMA_VERSION,
  operation,
  compatibility_result: checkResult(compatibilityReasons),
  integrity_result: checkResult(integrityReasons),
  restored_active_head: null,
  pending_outbox_state: { pending_count: 0, in_flight_count: 0 },
  storage_migrations_applied: [],
  rollback_result: { status: "not_required", reason_codes: [] },
  projections_requiring_rebuild: [],
});

const withOperation = (
  report: RuntimeRecoveryVerificationOrRestoreReport,
  operation: "verify" | "restore",
): RuntimeRecoveryVerificationOrRestoreReport => ({ ...report, operation });

const databasePathFor = (stateRoot: string, instanceId: string): string => {
  if (!instanceIdPattern.test(instanceId)) {
    throw new Error("INSTANCE_ID_INVALID");
  }
  return join(stateRoot, instanceId, "runtime.sqlite");
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
};

const insertRows = (
  target: DatabaseSync,
  table: "state_events" | "reanswer_outbox",
  columns: readonly string[],
  rows: readonly Row[],
): void => {
  const placeholders = columns.map(() => "?").join(", ");
  const statement = target.prepare(
    `INSERT INTO ${table}(${columns.join(", ")}) VALUES (${placeholders})`,
  );
  for (const row of rows) {
    statement.run(...columns.map((column) => toSqlValue(row[column] ?? null)));
  }
};

const readSnapshotState = (database: DatabaseSync): SnapshotState => {
  const integrity = database.prepare("PRAGMA integrity_check").get() as Row | undefined;
  if (integrity === undefined || Object.values(integrity)[0] !== "ok") {
    throw new Error("SQLITE_INTEGRITY_FAILED");
  }
  const head = database
    .prepare(
      "SELECT active_seq, view_version, checksum FROM state_head WHERE singleton = 1",
    )
    .get() as Row | undefined;
  if (head === undefined) {
    throw new Error("STATE_HEAD_MISSING");
  }
  const invalidEvents = database
    .prepare("SELECT count(*) AS count FROM state_events WHERE seq > ?")
    .get(readNumber(head, "active_seq")) as Row | undefined;
  if (invalidEvents === undefined || readNumber(invalidEvents, "count") !== 0) {
    throw new Error("STATE_BOUNDARY_MISMATCH");
  }
  const invalidOutbox = database
    .prepare(
      `SELECT count(*) AS count FROM reanswer_outbox
       WHERE status NOT IN ('pending', 'in_flight')
          OR successful_completion_count != 0
          OR attempt_count < 0`,
    )
    .get() as Row | undefined;
  const duplicateSessions = database
    .prepare(
      `SELECT count(*) AS count FROM (
         SELECT session_key_hash FROM reanswer_outbox
         GROUP BY session_key_hash HAVING count(*) > 1
       )`,
    )
    .get() as Row | undefined;
  if (
    invalidOutbox === undefined ||
    duplicateSessions === undefined ||
    readNumber(invalidOutbox, "count") !== 0 ||
    readNumber(duplicateSessions, "count") !== 0
  ) {
    throw new Error("OUTBOX_INVARIANT_FAILED");
  }
  const counts = database
    .prepare(
      `SELECT
         sum(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
         sum(CASE WHEN status = 'in_flight' THEN 1 ELSE 0 END) AS in_flight_count
       FROM reanswer_outbox`,
    )
    .get() as Row | undefined;
  return {
    activeHead: {
      activeSeq: readNumber(head, "active_seq"),
      viewVersion: readString(head, "view_version"),
      checksum: readString(head, "checksum"),
    },
    pendingCount: counts === undefined ? 0 : Number(counts.pending_count ?? 0),
    inFlightCount: counts === undefined ? 0 : Number(counts.in_flight_count ?? 0),
  };
};

const authorityDigest = (databasePath: string): string => {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const state = readSnapshotState(database);
    const events = toRows(
      database.prepare("SELECT * FROM state_events ORDER BY seq").all(),
    );
    const outbox = toRows(
      database
        .prepare("SELECT * FROM reanswer_outbox ORDER BY correction_id")
        .all(),
    ).map((row) =>
      readString(row, "status") === "in_flight"
        ? {
            ...row,
            status: "pending",
            successor_run_id: null,
            delivery_mode: null,
            last_error_code: "RECOVERY_INTERRUPTED_ATTEMPT",
          }
        : row,
    );
    return sha256(JSON.stringify({ state, events, outbox }));
  } finally {
    database.close();
  }
};

const compatibilityReasons = (
  manifest: RuntimeRecoverySnapshotManifest,
  options: RuntimeVerifyOptions,
): readonly string[] => {
  const reasons: string[] = [];
  if (!options.supportedSnapshotSchemaVersions.includes(manifest.snapshot_schema_version)) {
    reasons.push("SNAPSHOT_SCHEMA_INCOMPATIBLE");
  }
  if (!options.supportedStorageSchemaVersions.includes(manifest.storage_schema_version)) {
    reasons.push("STORAGE_SCHEMA_INCOMPATIBLE");
  }
  if (!options.supportedPackageVersions.includes(manifest.package_version)) {
    reasons.push("PACKAGE_VERSION_INCOMPATIBLE");
  }
  if (!options.supportedContractVersions.includes(manifest.contract_version)) {
    reasons.push("CONTRACT_VERSION_INCOMPATIBLE");
  }
  if (
    options.expectedInstanceId !== undefined &&
    options.expectedInstanceId !== manifest.instance_id
  ) {
    reasons.push("INSTANCE_MISMATCH");
  }
  return reasons;
};

export async function openRuntimeRecoverySnapshot(
  directory: string,
  expectedArtifactId?: string,
): Promise<RuntimeRecoverySnapshot> {
  const manifestText = await readFile(join(directory, "manifest.json"), "utf8");
  const recordedArtifactId = (
    await readFile(join(directory, ARTIFACT_ID_PATH), "utf8")
  ).trim();
  const parsed: unknown = JSON.parse(manifestText);
  const validation = validateContract(
    "runtime-recovery-snapshot-manifest",
    parsed,
  );
  if (!validation.valid) {
    throw new Error("SNAPSHOT_MANIFEST_INVALID");
  }
  const artifactId = sha256(manifestText);
  if (
    recordedArtifactId !== artifactId ||
    (expectedArtifactId !== undefined && expectedArtifactId !== artifactId)
  ) {
    throw new Error("SNAPSHOT_ARTIFACT_ID_MISMATCH");
  }
  return {
    artifactId,
    directory,
    manifest: parsed as RuntimeRecoverySnapshotManifest,
  };
}

class RuntimeRecovery implements RuntimeRecoveryPort {
  readonly #options: RuntimeRecoveryStorageOptions;

  constructor(options: RuntimeRecoveryStorageOptions) {
    this.#options = options;
  }

  async backup(options: RuntimeBackupOptions): Promise<RuntimeRecoverySnapshot> {
    if (!instanceIdPattern.test(options.instanceId)) {
      throw new Error("INSTANCE_ID_INVALID");
    }
    if (options.authorityRevision.length === 0) {
      throw new Error("AUTHORITY_REVISION_REQUIRED");
    }
    if (await fileExists(options.outputDirectory)) {
      throw new Error("SNAPSHOT_OUTPUT_EXISTS");
    }

    const sourcePath = databasePathFor(this.#options.stateRoot, options.instanceId);
    const artifactPath = join(options.outputDirectory, SNAPSHOT_DATABASE_PATH);
    let source: DatabaseSync | undefined;
    let target: DatabaseSync | undefined;
    try {
      await mkdir(dirname(artifactPath), { recursive: true, mode: 0o700 });
      source = new DatabaseSync(sourcePath);
      source.exec("BEGIN");
      const head = source
        .prepare(
          "SELECT active_seq, view_version, checksum, activated_at FROM state_head WHERE singleton = 1",
        )
        .get() as Row | undefined;
      if (head === undefined) {
        throw new Error("STATE_HEAD_MISSING");
      }
      const events = toRows(
        source
          .prepare("SELECT * FROM state_events WHERE seq <= ? ORDER BY seq")
          .all(readNumber(head, "active_seq")),
      );
      const outbox = toRows(
        source
          .prepare(
            "SELECT * FROM reanswer_outbox WHERE status IN ('pending', 'in_flight') ORDER BY correction_id",
          )
          .all(),
      );

      target = new DatabaseSync(artifactPath);
      target.exec(portableSchema);
      target.exec("BEGIN IMMEDIATE");
      insertRows(
        target,
        "state_events",
        [
          "seq",
          "event_id",
          "state_id",
          "event_type",
          "payload",
          "observed_at",
          "source_kind",
          "source_ref",
          "corrects_event_id",
          "supersedes_event_id",
          "idempotency_key",
          "created_at",
        ],
        events,
      );
      target
        .prepare(
          "INSERT INTO state_head(singleton, active_seq, view_version, checksum, activated_at) VALUES (1, ?, ?, ?, ?)",
        )
        .run(
          readNumber(head, "active_seq"),
          readString(head, "view_version"),
          readString(head, "checksum"),
          readString(head, "activated_at"),
        );
      insertRows(
        target,
        "reanswer_outbox",
        [
          "correction_id",
          "instance_id",
          "session_key_hash",
          "prior_run_id",
          "new_view_version",
          "status",
          "attempt_count",
          "successful_completion_count",
          "successor_run_id",
          "delivery_mode",
          "last_error_code",
          "idempotency_key",
          "created_at",
          "updated_at",
        ],
        outbox,
      );
      target.exec("COMMIT");
      source.exec("COMMIT");
      target.close();
      target = undefined;
      source.close();
      source = undefined;

      const state = (() => {
        const database = new DatabaseSync(artifactPath, { readOnly: true });
        try {
          return readSnapshotState(database);
        } finally {
          database.close();
        }
      })();
      const artifactBytes = await readFile(artifactPath);
      const manifest: RuntimeRecoverySnapshotManifest = {
        snapshot_schema_version: SNAPSHOT_SCHEMA_VERSION,
        storage_schema_version: this.#options.storageSchemaVersion,
        package_version: this.#options.packageVersion,
        contract_version: CONTRACT_VERSION,
        instance_id: options.instanceId,
        authority_revision: options.authorityRevision,
        state_boundary: {
          active_seq: state.activeHead.activeSeq,
          state_view_version: state.activeHead.viewVersion,
          checksum: state.activeHead.checksum,
        },
        files: [
          {
            path: SNAPSHOT_DATABASE_PATH,
            size: artifactBytes.byteLength,
            checksum: sha256(artifactBytes),
          },
        ],
        pending_outbox_summary: {
          pending_count: state.pendingCount,
          in_flight_count: state.inFlightCount,
        },
        created_at: (this.#options.now ?? (() => new Date().toISOString()))(),
        projections_requiring_rebuild: [...PROJECTIONS_REQUIRING_REBUILD],
      };
      if (!validateContract("runtime-recovery-snapshot-manifest", manifest).valid) {
        throw new Error("SNAPSHOT_MANIFEST_INVALID");
      }
      const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
      const artifactId = sha256(manifestText);
      await writeFile(join(options.outputDirectory, "manifest.json"), manifestText, {
        mode: 0o400,
      });
      await writeFile(
        join(options.outputDirectory, ARTIFACT_ID_PATH),
        `${artifactId}\n`,
        { mode: 0o400 },
      );
      await chmod(artifactPath, 0o400);
      return {
        artifactId,
        directory: options.outputDirectory,
        manifest,
      };
    } catch (error: unknown) {
      try {
        target?.exec("ROLLBACK");
      } catch {}
      try {
        source?.exec("ROLLBACK");
      } catch {}
      target?.close();
      source?.close();
      await chmod(options.outputDirectory, 0o700).catch(() => {});
      await chmod(join(options.outputDirectory, "authoritative"), 0o700).catch(
        () => {},
      );
      await rm(options.outputDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  async verify(
    snapshot: RuntimeRecoverySnapshot,
    options: RuntimeVerifyOptions,
  ): Promise<RuntimeRecoveryVerificationOrRestoreReport> {
    if (options.access !== "read_only") {
      return emptyReport("verify", [], ["VERIFY_NOT_READ_ONLY"]);
    }
    if (!validateContract("runtime-recovery-snapshot-manifest", snapshot.manifest).valid) {
      return emptyReport("verify", [], ["MANIFEST_INVALID"]);
    }
    const compatibility = compatibilityReasons(snapshot.manifest, options);
    const integrity: string[] = [];
    let state: SnapshotState | undefined;
    try {
      const manifestText = await readFile(
        join(snapshot.directory, "manifest.json"),
        "utf8",
      );
      const recordedArtifactId = (
        await readFile(join(snapshot.directory, ARTIFACT_ID_PATH), "utf8")
      ).trim();
      if (
        sha256(manifestText) !== snapshot.artifactId ||
        recordedArtifactId !== snapshot.artifactId
      ) {
        integrity.push("MANIFEST_CHECKSUM_MISMATCH");
      }
      for (const file of snapshot.manifest.files) {
        const bytes = await readFile(join(snapshot.directory, file.path));
        if (bytes.byteLength !== file.size || sha256(bytes) !== file.checksum) {
          integrity.push("CHECKSUM_MISMATCH");
        }
      }
      if (integrity.length === 0) {
        const database = new DatabaseSync(
          join(snapshot.directory, SNAPSHOT_DATABASE_PATH),
          { readOnly: true },
        );
        try {
          state = readSnapshotState(database);
          const foreignInstance = database
            .prepare(
              "SELECT count(*) AS count FROM reanswer_outbox WHERE instance_id != ?",
            )
            .get(snapshot.manifest.instance_id) as Row | undefined;
          if (
            foreignInstance === undefined ||
            readNumber(foreignInstance, "count") !== 0
          ) {
            integrity.push("OUTBOX_INSTANCE_MISMATCH");
          }
        } finally {
          database.close();
        }
        if (
          state.activeHead.activeSeq !==
            snapshot.manifest.state_boundary.active_seq ||
          state.activeHead.viewVersion !==
            snapshot.manifest.state_boundary.state_view_version ||
          state.activeHead.checksum !== snapshot.manifest.state_boundary.checksum
        ) {
          integrity.push("STATE_BOUNDARY_MISMATCH");
        }
        if (
          state.pendingCount !==
            snapshot.manifest.pending_outbox_summary.pending_count ||
          state.inFlightCount !==
            snapshot.manifest.pending_outbox_summary.in_flight_count
        ) {
          integrity.push("OUTBOX_SUMMARY_MISMATCH");
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "";
      integrity.push(
        /^[A-Z][A-Z0-9_]+$/.test(message)
          ? message
          : "SNAPSHOT_DATABASE_INVALID",
      );
    }
    return {
      report_schema_version: REPORT_SCHEMA_VERSION,
      operation: "verify",
      compatibility_result: checkResult(compatibility),
      integrity_result: checkResult(integrity),
      restored_active_head: null,
      pending_outbox_state: {
        pending_count: state?.pendingCount ?? 0,
        in_flight_count: state?.inFlightCount ?? 0,
      },
      storage_migrations_applied: [],
      rollback_result: { status: "not_required", reason_codes: [] },
      projections_requiring_rebuild: [
        ...snapshot.manifest.projections_requiring_rebuild,
      ],
    };
  }

  async restore(
    snapshot: RuntimeRecoverySnapshot,
    options: RuntimeRestoreOptions,
  ): Promise<RuntimeRecoveryVerificationOrRestoreReport> {
    const verification = await this.verify(snapshot, {
      expectedInstanceId: options.targetInstanceId,
      supportedSnapshotSchemaVersions: options.supportedSnapshotSchemaVersions,
      supportedStorageSchemaVersions: options.supportedStorageSchemaVersions,
      supportedPackageVersions: options.supportedPackageVersions,
      supportedContractVersions: options.supportedContractVersions,
      access: "read_only",
    });
    if (options.targetHasServedRun) {
      return {
        ...withOperation(verification, "restore"),
        compatibility_result: checkResult([
          ...verification.compatibility_result.reason_codes,
          "TARGET_HAS_SERVED_RUN",
        ]),
      };
    }
    if (
      verification.compatibility_result.status === "fail" ||
      verification.integrity_result.status === "fail"
    ) {
      return withOperation(verification, "restore");
    }

    const targetPath = databasePathFor(
      this.#options.stateRoot,
      options.targetInstanceId,
    );
    const targetDirectory = dirname(targetPath);
    const artifactPath = join(snapshot.directory, SNAPSHOT_DATABASE_PATH);
    const restoreHash = sha256(options.restoreIdempotencyKey).slice(7);
    const stagePath = join(targetDirectory, `.restore-${restoreHash}.sqlite`);
    const rollbackDirectory = join(
      this.#options.stateRoot,
      ".recovery-rollback",
      options.targetInstanceId,
    );
    const rollbackPath = join(rollbackDirectory, `${restoreHash}.sqlite`);
    const absentMarkerPath = join(rollbackDirectory, `${restoreHash}.absent.json`);
    let targetExisted = false;
    let targetReplaced = false;
    try {
      if (isAborted(options.signal)) {
        throw new Error("RESTORE_INTERRUPTED");
      }
      await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
      await copyFile(artifactPath, stagePath);
      await chmod(stagePath, 0o600);
      const staged = new DatabaseSync(stagePath);
      try {
        staged
          .prepare(
            `UPDATE reanswer_outbox
             SET status = 'pending', successor_run_id = NULL,
                 delivery_mode = NULL,
                 last_error_code = 'RECOVERY_INTERRUPTED_ATTEMPT'
             WHERE status = 'in_flight'`,
          )
          .run();
        readSnapshotState(staged);
      } finally {
        staged.close();
      }

      targetExisted = await fileExists(targetPath);
      if (targetExisted) {
        try {
          if (authorityDigest(targetPath) === authorityDigest(stagePath)) {
            await unlink(stagePath);
            return {
              ...withOperation(verification, "restore"),
              restored_active_head: {
                active_seq: snapshot.manifest.state_boundary.active_seq,
                state_view_version:
                  snapshot.manifest.state_boundary.state_view_version,
                checksum: snapshot.manifest.state_boundary.checksum,
              },
              pending_outbox_state: {
                pending_count:
                  snapshot.manifest.pending_outbox_summary.pending_count +
                  snapshot.manifest.pending_outbox_summary.in_flight_count,
                in_flight_count: 0,
              },
              rollback_result: {
                status: "not_required",
                reason_codes: ["RESTORE_ALREADY_APPLIED"],
              },
            };
          }
        } catch {
          // A malformed target is still replaceable because rollback preserves it.
        }
      }
      if (isAborted(options.signal)) {
        throw new Error("RESTORE_INTERRUPTED");
      }

      await mkdir(rollbackDirectory, { recursive: true, mode: 0o700 });
      if (targetExisted) {
        await copyFile(targetPath, rollbackPath);
      } else {
        await writeFile(
          absentMarkerPath,
          `${JSON.stringify({ target_existed: false })}\n`,
          { mode: 0o600 },
        );
      }
      await rename(stagePath, targetPath);
      targetReplaced = true;

      if (isAborted(options.signal)) {
        throw new Error("RESTORE_INTERRUPTED");
      }
      const restored = new DatabaseSync(targetPath, { readOnly: true });
      let restoredState: SnapshotState;
      try {
        restoredState = readSnapshotState(restored);
      } finally {
        restored.close();
      }
      return {
        ...withOperation(verification, "restore"),
        restored_active_head: {
          active_seq: restoredState.activeHead.activeSeq,
          state_view_version: restoredState.activeHead.viewVersion,
          checksum: restoredState.activeHead.checksum,
        },
        pending_outbox_state: {
          pending_count: restoredState.pendingCount,
          in_flight_count: restoredState.inFlightCount,
        },
      };
    } catch (error: unknown) {
      const reason =
        error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "RESTORE_FAILED";
      let rollbackStatus: "completed" | "failed" = "completed";
      if (targetReplaced) {
        try {
          if (targetExisted) {
            await copyFile(rollbackPath, targetPath);
          } else {
            await unlink(targetPath);
          }
        } catch {
          rollbackStatus = "failed";
        }
      }
      await unlink(stagePath).catch(() => {});
      return {
        ...withOperation(verification, "restore"),
        integrity_result: checkResult([reason]),
        rollback_result: {
          status: targetReplaced ? rollbackStatus : "not_required",
          reason_codes: [reason],
        },
      };
    }
  }
}

export function createRuntimeRecoveryPort(
  options: RuntimeRecoveryStorageOptions,
): RuntimeRecoveryPort {
  return new RuntimeRecovery(options);
}
