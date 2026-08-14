/* Generated from contracts/v2. Do not edit directly. */

export type Id = string;
export type Checksum = string;

export interface DecisionReceipt {
  schema_version: "cognitive-runtime.decision-receipt/v2";
  receipt_id: Id;
  request_id: Id;
  candidate_id: Id;
  candidate_revision: number;
  candidate_checksum: Checksum;
  base_authority_version: null | string;
  decision: "accepted" | "rejected" | "rewritten";
  decided_by: Id;
  message_reference: {
    provider: "telegram";
    instance_id: Id;
    account_id: string;
    conversation_id: string;
    message_id: string;
  };
  decided_at: string;
  single_use: true;
}
