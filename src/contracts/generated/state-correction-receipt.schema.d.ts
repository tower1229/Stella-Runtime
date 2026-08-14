/* Generated from contracts/v2. Do not edit directly. */

export type Id = string;
export type Checksum = string;

export interface StateCorrectionReceipt {
  schema_version: "cognitive-runtime.state-correction-receipt/v2";
  receipt_id: Id;
  preview_id: Id;
  preview_checksum: Checksum;
  base_state_view_checksum: Checksum;
  confirmed_by: Id;
  confirmation_method: "cli_plan_apply" | "confirmed_channel";
  confirmed_at: string;
  single_use: true;
}
