/* Generated from contracts/v2. Do not edit directly. */

export type Id = string;
export type Generation = string;
export type Checksum = string;

export interface ActivationReceipt {
  schema_version: "cognitive-runtime.activation-receipt/v2";
  receipt_id: Id;
  instance_id: Id;
  generation_id: Generation;
  source_revision: string;
  manifest_checksum: Checksum;
  projection_checksum: Checksum;
  host_config_checksum: Checksum;
  index_evidence: {
    deep_status: "pass";
    search_sentinel_checksum: Checksum;
    get_sentinel_checksum: Checksum;
  };
  cutover_plan_checksum?: Checksum;
  release_channel: string;
  openclaw_version: string;
  node_version: string;
  verified_at: string;
}
