/* Generated from contracts/v2. Do not edit directly. */

export type Id = string;
export type NullableVersion = null | string;
export type NullableChecksum = null | Checksum;
export type Checksum = string;

export interface AuthorityCandidate {
  schema_version: "cognitive-runtime.authority-candidate/v2";
  candidate_id: Id;
  revision: number;
  candidate_type: "semantic" | "personal_model" | "cognitive";
  stable_id: Id;
  base_authority_version: NullableVersion;
  base_checksum: NullableChecksum;
  content: {
    [k: string]: unknown;
  };
  /**
   * @minItems 1
   */
  source_map: [SourceMap, ...SourceMap[]];
  exact_diff: string;
  checksum: Checksum;
  created_at: string;
}
export interface SourceMap {
  source_ref: Id;
  content_path: string;
}
