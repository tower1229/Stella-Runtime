/* Generated from contracts/v2. Do not edit directly. */

export type Id = string;

export interface InstanceRuntimeConfig {
  schema_version: "cognitive-runtime.instance-runtime-config/v2";
  instance_id: Id;
  mode: "off" | "observe" | "enforce";
  runtime_storage: string;
  generation_storage: string;
  host: {
    agent_id: Id;
    eligible_scope: ["private_main_session"];
  };
  authority_owner: {
    provider: "telegram";
    actor_id: string;
  };
  limits: {
    max_active_runs: number;
    drain_timeout_ms: number;
  };
  adapters: {
    authority_checkout: string;
    host_retrieval: string;
    public_corpus?: string;
  };
}
