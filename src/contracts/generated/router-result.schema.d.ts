/* Generated from contracts/v1. Do not edit directly. */

export type Id = string;
export type Ids = Id[];
export type NullableId = null | Id;
export type RetrievalStep = {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  layer: "evidence" | "semantic" | "cognitive" | "current_state";
  method: "direct_get" | "search";
  target: NullableId;
  query: null | string;
  purpose: string;
} & {
  layer: "evidence" | "semantic" | "cognitive" | "current_state";
  method: "direct_get" | "search";
  target: NullableId;
  query: null | string;
  purpose: string;
} & {
  layer: "evidence" | "semantic" | "cognitive" | "current_state";
  method: "direct_get" | "search";
  target: NullableId;
  query: null | string;
  purpose: string;
} & {
  layer: "evidence" | "semantic" | "cognitive" | "current_state";
  method: "direct_get" | "search";
  target: NullableId;
  query: null | string;
  purpose: string;
} & {
  layer: "evidence" | "semantic" | "cognitive" | "current_state";
  method: "direct_get" | "search";
  target: NullableId;
  query: null | string;
  purpose: string;
} & {
  layer: "evidence" | "semantic" | "cognitive" | "current_state";
  method: "direct_get" | "search";
  target: NullableId;
  query: null | string;
  purpose: string;
};

export interface RouterResult {
  memory_route: "none" | "optional" | "required";
  state_refs: Ids;
  governing: null | {
    system: Id;
    kernel_version: string;
    /**
     * @maxItems 2
     */
    modules: [] | [Id] | [Id, Id];
  };
  frameworks: {
    primary: NullableId;
    secondary: NullableId;
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
