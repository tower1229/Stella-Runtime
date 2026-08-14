/* Generated from contracts/v2. Do not edit directly. */

export type StableId = string;
export type UniqueStrings = string[];
export type Date = string;
/**
 * @minItems 1
 */
export type NonEmptyRefs = [StableId, ...StableId[]];
export type UniqueRefs = StableId[];

export interface SemanticClaim {
  schema_version: "cognitive-runtime.semantic/v2";
  claim_id: StableId;
  record_type: string;
  aliases: UniqueStrings;
  scope: Scope;
  valid_time: ValidTime;
  epistemic: string;
  confidence: "low" | "medium" | "high";
  source_refs: NonEmptyRefs;
  related_claims: UniqueRefs;
  supersedes: UniqueRefs;
  created_at: Date;
  updated_at: Date;
}
export interface Scope {
  contexts: UniqueStrings;
  conditions: UniqueStrings;
}
export interface ValidTime {
  from: Date;
  to: null | Date;
}
