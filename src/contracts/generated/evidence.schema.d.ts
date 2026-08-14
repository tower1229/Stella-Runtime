/* Generated from contracts/v2. Do not edit directly. */

export type StableId = string;
export type TemporalValue = {
  [k: string]: unknown;
} & {
  value: string;
  precision: "year" | "month" | "day" | "instant";
};
/**
 * @minItems 1
 */
export type NonEmptyUniqueStrings = [string, ...string[]];
export type UniqueStrings = string[];
export type Media = {
  [k: string]: unknown;
} & {
  id: StableId;
  path: string;
  role: string;
  importance: "low" | "medium" | "high";
  caption: string;
  salient?: boolean;
  visual_thesis?: string;
};

export interface EvidenceSource {
  schema_version: "cognitive-runtime.evidence/v2";
  source_id: StableId;
  source_type: string;
  created_at: TemporalValue;
  imported_at: TemporalValue;
  sensitivity: string;
  allowed_scenarios: NonEmptyUniqueStrings;
  not_allowed_scenarios: UniqueStrings;
  quote_policy: string;
  status: string;
  tags: UniqueStrings;
  media: Media[];
}
