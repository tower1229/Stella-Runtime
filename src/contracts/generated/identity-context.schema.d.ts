/* Generated from contracts/stella/v1. Do not edit directly. */

export type Id = string;

export interface StellaIdentityContext {
  schema_version: "stella.identity-context/v1";
  instance_id: Id;
  producer_id: "stella-runtime";
  consumer_id: "stella-fitness";
  source_revision: string;
  as_of: string;
  /**
   * @minItems 1
   * @maxItems 2
   */
  categories: ["background" | "identity"] | ["background" | "identity", "background" | "identity"];
  /**
   * @maxItems 256
   */
  entries: Entry[];
}
export interface Entry {
  id: Id;
  category: "background" | "identity";
  content: string;
  /**
   * @minItems 1
   * @maxItems 64
   */
  source_reference_ids: [Id, ...Id[]];
}
