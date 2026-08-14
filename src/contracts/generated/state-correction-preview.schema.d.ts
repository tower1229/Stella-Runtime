/* Generated from contracts/v2. Do not edit directly. */

export type Id = string;
export type Checksum = string;

export interface StateCorrectionPreview {
  schema_version: "cognitive-runtime.state-correction-preview/v2";
  preview_id: Id;
  instance_id: Id;
  base_state_view_checksum: Checksum;
  proposed_event: {
    [k: string]: unknown;
  };
  preview_checksum: Checksum;
  created_at: string;
  expires_at: string;
}
