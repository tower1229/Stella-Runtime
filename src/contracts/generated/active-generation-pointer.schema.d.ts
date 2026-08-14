/* Generated from contracts/v2. Do not edit directly. */

export type Id = string;
export type Generation = string;
export type Checksum = string;

export interface ActiveGenerationPointer {
  schema_version: "cognitive-runtime.active-generation-pointer/v2";
  instance_id: Id;
  generation_id: Generation;
  source_revision: string;
  manifest_checksum: Checksum;
  activation_receipt_id: Id;
  activated_at: string;
}
