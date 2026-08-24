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

export interface CompositeActiveGenerationPointer {
  schema_version: "cognitive-runtime.active-generation-pointer/v3";
  instance_id: Id;
  generation_id: Generation;
  source_revision: AuthorityRevision;
  authority: Authority;
  domains: Domains;
  manifest_checksum: Checksum;
  activation_receipt_id: Id;
  activated_at: string;
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
