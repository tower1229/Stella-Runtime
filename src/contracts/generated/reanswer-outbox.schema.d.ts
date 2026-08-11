/* Generated from contracts/v1. Do not edit directly. */

export type ReanswerOutbox = {
  [k: string]: unknown;
} & {
  schema_version: "cognitive-runtime.reanswer-outbox/v1";
  correction_id: Id;
  instance_id: Id;
  session_key_hash: Checksum;
  prior_run_id: Id;
  new_view_version: string;
  status: "pending" | "in_flight" | "completed";
  attempt_count: number;
  successful_completion_count: number;
  successor_run_id?: Id;
  last_error_code?: string;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
};
export type Id = string;
export type Checksum = string;
