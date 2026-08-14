/* Generated from contracts/v2. Do not edit directly. */

export type Id = string;
export type Checksum = string;

export interface StateView {
  schema_version: "cognitive-runtime.state-view/v2";
  instance_id: Id;
  view_version: string;
  active_seq: number;
  values: Value[];
  checksum: Checksum;
  created_at: string;
}
export interface Value {
  state_id: Id;
  value: unknown;
  source_event_id: Id;
}
