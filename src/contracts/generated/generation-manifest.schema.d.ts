/* Generated from contracts/v2. Do not edit directly. */

export type Generation = string;
export type Checksum = string;

export interface GenerationManifest {
  schema_version: "cognitive-runtime.generation-manifest/v2";
  contract_version: "v2";
  package_version: string;
  source_revision: string;
  sync_generation: Generation;
  /**
   * @minItems 1
   */
  files: [Artifact, ...Artifact[]];
}
export interface Artifact {
  path: string;
  checksum: Checksum;
  dependencies: string[];
}
