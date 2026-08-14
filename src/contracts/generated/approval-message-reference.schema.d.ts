/* Generated from contracts/v2. Do not edit directly. */

export type Id = string;

export interface ApprovalMessageReference {
  schema_version: "cognitive-runtime.approval-message-reference/v2";
  provider: "telegram";
  instance_id: Id;
  account_id: string;
  conversation_id: string;
  message_id: string;
}
