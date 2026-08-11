/* Generated from contracts/v1. Do not edit directly. */

export type StableId = string;
export type UniqueStrings = string[];
/**
 * @minItems 1
 */
export type NonEmptyStrings = [string, ...string[]];
export type NullableId = null | StableId;
export type UniqueIds = StableId[];
/**
 * @minItems 1
 */
export type NonEmptyIds = [StableId, ...StableId[]];
export type Date = string;

export interface CognitiveEntity {
  schema_version: "cognitive-runtime.cognitive/v1";
  cognitive_id: StableId;
  entity_type:
    "governing_system" | "governing_module" | "epistemic_method" | "decision_framework" | "reflection_framework";
  entity_version: number;
  title: string;
  aliases: UniqueStrings;
  cognitive_jobs: NonEmptyStrings;
  route_signals: UniqueStrings;
  relations: {
    governed_by: NullableId;
    parent: NullableId;
    complements: UniqueIds;
    tensions: UniqueIds;
  };
  source_refs: NonEmptyIds;
  confirmed_at: Date;
  updated_at: Date;
}
