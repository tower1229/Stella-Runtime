/* Generated from contracts/v2. Do not edit directly. */

export type Id = string;
export type Checksum = string;

export interface ProjectionEntry {
  schema_version: "cognitive-runtime.projection-entry/v2";
  generation_id: string;
  layer: "evidence" | "semantic" | "cognitive";
  stable_id: Id;
  authority_version: string;
  role: "evidence" | "semantic" | "personal_model" | "governing_system" | "governing_module" | "ordinary_framework";
  checksum: Checksum;
  source_refs: Id[];
  content: string;
}
