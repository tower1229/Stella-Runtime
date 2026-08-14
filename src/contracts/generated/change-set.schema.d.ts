/* Generated from contracts/v2. Do not edit directly. */

export type Id = string;
export type Checksum = string;

export interface ChangeSet {
  schema_version: "cognitive-runtime.change-set/v2";
  change_set_id: Id;
  approval_receipt_id: Id;
  candidate_id: Id;
  candidate_revision: number;
  candidate_checksum: Checksum;
  base_authority_version: null | string;
  base_checksum: null | Checksum;
  /**
   * @minItems 1
   */
  operations: [Operation, ...Operation[]];
  checksum: Checksum;
  created_at: string;
}
export interface Operation {
  operation: "write" | "delete";
  path: string;
  content_checksum: Checksum;
}
