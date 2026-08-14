/* Generated from contracts/v2. Do not edit directly. */

export type Id = string;
export type Checksum = string;

export interface InstanceCutoverPlan {
  schema_version: "cognitive-runtime.instance-cutover-plan/v2";
  plan_id: Id;
  instance_id: Id;
  target_source_revision: string;
  publication_prerequisites: {
    remote_base_check: boolean;
    push_before_sync: boolean;
  };
  remove_retrieval_paths: string[];
  disable_mechanisms: string[];
  preserve_independent_paths: string[];
  bootstrap_targets: ("USER.md" | "MEMORY.md")[];
  public_corpus_adapter?: string;
  checksum: Checksum;
}
