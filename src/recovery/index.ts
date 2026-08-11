import type {
  RuntimeRecoverySnapshotManifest,
  RuntimeRecoveryVerificationOrRestoreReport,
} from "../contracts/index.js";

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

export interface RuntimeRecoverySnapshot {
  readonly artifactId: string;
  readonly manifest: RuntimeRecoverySnapshotManifest;
}

export interface RuntimeBackupOptions {
  readonly instanceId: string;
  readonly authorityRevision: string;
  readonly consistency: "transactional_boundary";
}

export interface RuntimeVerifyOptions {
  readonly expectedInstanceId: string;
  readonly supportedSnapshotSchemaVersions: readonly string[];
  readonly supportedStorageSchemaVersions: readonly string[];
  readonly access: "read_only";
}

export interface RuntimeRestoreOptions {
  readonly targetInstanceId: string;
  readonly targetHasServedRun: boolean;
  readonly restoreIdempotencyKey: string;
  readonly rollback: "required";
  readonly supportedSnapshotSchemaVersions: readonly string[];
  readonly supportedStorageSchemaVersions: readonly string[];
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
