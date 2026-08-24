/* Generated from contracts/v3. Do not edit directly. */

export type AuthorityRevision = string;
export type Checksum = string;
/**
 * @minItems 1
 * @maxItems 32
 */
export type Domains = [Domain, ...Domain[]];
export type Id = string;
export type ProjectionRevision = string;
export type PointerRevision = string;
export type SourceRevision = string;
export type Generation = string;

export interface CompositeGenerationManifest {
  schema_version: "cognitive-runtime.generation-manifest/v3";
  contract_version: "v2";
  builder_format_version: "generation-builder/v3";
  package_version: string;
  source_revision: AuthorityRevision;
  authority: Authority;
  domains: Domains;
  sync_generation: Generation;
  /**
   * @minItems 1
   */
  files: [Artifact, ...Artifact[]];
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
export interface Artifact {
  path: string;
  checksum: Checksum;
  dependencies: string[];
}
