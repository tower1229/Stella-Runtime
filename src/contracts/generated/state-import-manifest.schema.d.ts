/* Generated from contracts/v2. Do not edit directly. */

export type Id = string;
export type Checksum = string;

export interface StateImportManifest {
  schema_version: "cognitive-runtime.state-import-manifest/v2";
  import_id: Id;
  instance_id: Id;
  initialized_head_checksum: Checksum;
  events: {
    [k: string]: unknown;
  }[];
  source_mappings: SourceMapping[];
  expected_head: {
    [k: string]: unknown;
  };
  expected_view: {
    [k: string]: unknown;
  };
  checksum: Checksum;
  created_at: string;
}
export interface SourceMapping {
  event_id: Id;
  source_kind: "user_confirmed" | "independently_verified";
  source_ref: Id;
  verification: string;
}
