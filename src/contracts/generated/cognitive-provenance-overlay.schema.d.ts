/* Generated from contracts/v1. Do not edit directly. */

export type Id = string;
export type Checksum = string;
export type Ids = string[];
export type RetrievalStep = {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  layer: "evidence" | "semantic" | "cognitive" | "current_state";
  method: "direct_get" | "search";
  target: null | string;
  query: null | string;
  purpose: string;
} & {
  layer: "evidence" | "semantic" | "cognitive" | "current_state";
  method: "direct_get" | "search";
  target: null | string;
  query: null | string;
  purpose: string;
} & {
  layer: "evidence" | "semantic" | "cognitive" | "current_state";
  method: "direct_get" | "search";
  target: null | string;
  query: null | string;
  purpose: string;
} & {
  layer: "evidence" | "semantic" | "cognitive" | "current_state";
  method: "direct_get" | "search";
  target: null | string;
  query: null | string;
  purpose: string;
} & {
  layer: "evidence" | "semantic" | "cognitive" | "current_state";
  method: "direct_get" | "search";
  target: null | string;
  query: null | string;
  purpose: string;
} & {
  layer: "evidence" | "semantic" | "cognitive" | "current_state";
  method: "direct_get" | "search";
  target: null | string;
  query: null | string;
  purpose: string;
};

export interface CognitiveProvenanceOverlay {
  schema_version: "cognitive-runtime.cognitive-provenance-overlay/v1";
  trace_id: Id;
  run_id: Id;
  session_key_hash: Checksum;
  sync_generation: string;
  knowledge_snapshot: string;
  state_view_version: string;
  validated_router_result: null | RouterResult;
  cognitive_bindings: Ref[];
  stable_refs: Ref[];
  unresolved_conflicts: Id[];
  trace_status: string;
  eval_eligible: boolean;
  created_at: string;
}
export interface RouterResult {
  memory_route: "none" | "optional" | "required";
  state_refs: Ids;
  governing: null | {
    system: string;
    kernel_version: string;
    /**
     * @maxItems 2
     */
    modules: [] | [string] | [string, string];
  };
  frameworks: {
    primary: null | string;
    secondary: null | string;
  };
  /**
   * @maxItems 6
   */
  retrieval_plan:
    | []
    | [RetrievalStep]
    | [RetrievalStep, RetrievalStep]
    | [RetrievalStep, RetrievalStep, RetrievalStep]
    | [RetrievalStep, RetrievalStep, RetrievalStep, RetrievalStep]
    | [RetrievalStep, RetrievalStep, RetrievalStep, RetrievalStep, RetrievalStep]
    | [RetrievalStep, RetrievalStep, RetrievalStep, RetrievalStep, RetrievalStep, RetrievalStep];
  confidence: number;
  reason_codes: string[];
}
export interface Ref {
  id: Id;
  status: "planned" | "retrieved" | "injected" | "declared_used" | "declared_excluded";
}
