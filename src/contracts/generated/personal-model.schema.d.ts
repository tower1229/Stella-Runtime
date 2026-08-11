/* Generated from contracts/v1. Do not edit directly. */

export type PersonalModel = (
  | {
      counterevidence_refs?: {
        [k: string]: unknown;
      };
      [k: string]: unknown;
    }
  | {
      competing_explanations?: {
        [k: string]: unknown;
      };
      [k: string]: unknown;
    }
) & {
  schema_version: "cognitive-runtime.personal-model/v1";
  claim_id: StableId;
  record_type: "personal_model";
  scope: Scope;
  epistemic: "user_confirmed_hypothesis";
  confidence: "low" | "medium" | "high";
  source_refs: NonEmptyRefs;
  counterevidence_refs: UniqueRefs;
  competing_explanations: NonEmptyStrings;
  revision_triggers: NonEmptyStrings;
  supersedes: UniqueRefs;
  created_at: Date;
  updated_at: Date;
};
export type StableId = string;
/**
 * @minItems 1
 */
export type NonEmptyStrings = [string, ...string[]];
/**
 * @minItems 1
 */
export type NonEmptyRefs = [StableId, ...StableId[]];
export type UniqueRefs = StableId[];
export type Date = string;

export interface Scope {
  contexts: NonEmptyStrings;
  conditions: NonEmptyStrings;
}
