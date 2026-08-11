/* Generated from contracts/v1. Do not edit directly. */

export type Checksum = string;

export interface RuntimeRecoverySnapshotManifest {
  snapshot_schema_version: "cognitive-runtime.runtime-recovery-snapshot-manifest/v1";
  storage_schema_version: string;
  package_version: string;
  contract_version: "v1";
  instance_id: string;
  authority_revision: string;
  state_boundary: {
    active_seq: number;
    state_view_version: string;
    checksum: Checksum;
  };
  files: {
    path: string;
    size: number;
    checksum: Checksum;
  }[];
  pending_outbox_summary: {
    pending_count: number;
    in_flight_count: number;
  };
  created_at: string;
  projections_requiring_rebuild: string[];
}
