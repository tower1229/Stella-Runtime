/* Generated from contracts/v1. Do not edit directly. */

export type StableId = string;
export type Date = string;
/**
 * @minItems 1
 */
export type NonEmptyUniqueStrings = [string, ...string[]];
export type UniqueStrings = string[];

export interface EvidenceSource {
  schema_version: "cognitive-runtime.evidence/v1";
  source_id: StableId;
  source_type: string;
  created_at: Date;
  imported_at: Date;
  sensitivity: string;
  allowed_scenarios: NonEmptyUniqueStrings;
  not_allowed_scenarios: UniqueStrings;
  quote_policy: string;
  status: string;
  tags: UniqueStrings;
}
