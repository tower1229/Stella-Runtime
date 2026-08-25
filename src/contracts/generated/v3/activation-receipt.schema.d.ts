/* Generated from contracts/v3. Do not edit directly. */

export type Id = string;
export type Generation = string;
export type AuthorityRevision = string;
export type Checksum = string;
/**
 * @minItems 1
 * @maxItems 32
 */
export type Domains = [Domain, ...Domain[]];
export type ProjectionRevision = string;
export type PointerRevision = string;
export type SourceRevision = string;

export interface CompositeActivationReceipt {
  schema_version: "cognitive-runtime.activation-receipt/v3";
  receipt_id: Id;
  instance_id: Id;
  generation_id: Generation;
  source_revision: AuthorityRevision;
  authority: Authority;
  domains: Domains;
  manifest_checksum: Checksum;
  projection_checksum: Checksum;
  host_config_checksum: Checksum;
  index_evidence: {
    deep_status: "pass";
    search_sentinel_checksum: Checksum;
    get_sentinel_checksum: Checksum;
    fitness?: FitnessIndexEvidence;
  };
  cutover_plan_checksum?: Checksum;
  release_channel: string;
  openclaw_version: string;
  node_version: string;
  verified_at: string;
}
export interface Authority {
  revision: AuthorityRevision;
  checksum: Checksum;
}
export interface Domain {
  domain_id: Id;
  status: "active" | "stale";
  projection_revision: ProjectionRevision;
  pointer_revision: PointerRevision;
  manifest_checksum: Checksum;
  source_revision: SourceRevision;
  as_of: string;
}
export interface FitnessIndexEvidence {
  projection_revision: ProjectionRevision;
  manifest_checksum: Checksum;
  desired_count: number;
  indexed_count: number;
  previous_revision: ProjectionRevision | null;
  previous_stable_id_hits: 0;
  previous_text_sentinel_hits: 0;
  previous_source_reference_hits: 0;
}
