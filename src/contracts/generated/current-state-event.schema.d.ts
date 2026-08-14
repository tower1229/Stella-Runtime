/* Generated from contracts/v2. Do not edit directly. */

export type StableId = string;

export interface CurrentStateEvent {
  seq: number;
  event_id: StableId;
  state_id: StableId;
  event_type: string;
  payload: {
    [k: string]: unknown;
  };
  observed_at: string;
  source_kind: string;
  source_ref?: StableId;
  corrects_event_id?: StableId;
  supersedes_event_id?: StableId;
  idempotency_key: string;
  created_at: string;
}
