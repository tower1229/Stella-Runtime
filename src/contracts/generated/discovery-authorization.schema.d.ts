/* Generated from contracts/v2. Do not edit directly. */

export type Id = string;

export interface DiscoveryAuthorization {
  schema_version: "cognitive-runtime.discovery-authorization/v2";
  authorization_id: Id;
  instance_id: Id;
  scope: {
    /**
     * @minItems 1
     */
    candidate_types: ["semantic" | "personal_model" | "cognitive", ...("semantic" | "personal_model" | "cognitive")[]];
    /**
     * @minItems 1
     */
    source_refs: [Id, ...Id[]];
  };
  granted_by: Id;
  granted_at: string;
  expires_at: string;
  status: "active" | "ended";
}
