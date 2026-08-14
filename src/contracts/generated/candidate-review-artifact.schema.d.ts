/* Generated from contracts/v2. Do not edit directly. */

export type Id = string;
export type Checksum = string;

export interface CandidateReviewArtifact {
  schema_version: "cognitive-runtime.candidate-review-artifact/v2";
  review_id: Id;
  candidate_id: Id;
  candidate_revision: number;
  candidate_checksum: Checksum;
  complete_candidate: {
    [k: string]: unknown;
  };
  base_authority_version: null | string;
  exact_diff: string;
  /**
   * @minItems 1
   */
  source_map: [
    {
      [k: string]: unknown;
    },
    ...{
      [k: string]: unknown;
    }[]
  ];
  created_at: string;
}
