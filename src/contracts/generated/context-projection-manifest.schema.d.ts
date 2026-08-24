/* Generated from contracts/stella/v1. Do not edit directly. */

export type StellaContextProjectionManifest = AllowedPair & {
  schema_version: "stella.context-projection-manifest/v1";
  instance_id: Id;
  producer_id: "stella-runtime" | "stella-fitness";
  consumer_id: "stella-fitness" | "stella-runtime";
  projection_revision: ProjectionRevision;
  source: {
    revision: SourceRevision;
    as_of: string;
  };
  /**
   * @minItems 1
   * @maxItems 8
   */
  categories:
    | ["background" | "fitness_history" | "identity"]
    | ["background" | "fitness_history" | "identity", "background" | "fitness_history" | "identity"]
    | [
        "background" | "fitness_history" | "identity",
        "background" | "fitness_history" | "identity",
        "background" | "fitness_history" | "identity"
      ]
    | [
        "background" | "fitness_history" | "identity",
        "background" | "fitness_history" | "identity",
        "background" | "fitness_history" | "identity",
        "background" | "fitness_history" | "identity"
      ]
    | [
        "background" | "fitness_history" | "identity",
        "background" | "fitness_history" | "identity",
        "background" | "fitness_history" | "identity",
        "background" | "fitness_history" | "identity",
        "background" | "fitness_history" | "identity"
      ]
    | [
        "background" | "fitness_history" | "identity",
        "background" | "fitness_history" | "identity",
        "background" | "fitness_history" | "identity",
        "background" | "fitness_history" | "identity",
        "background" | "fitness_history" | "identity",
        "background" | "fitness_history" | "identity"
      ]
    | [
        "background" | "fitness_history" | "identity",
        "background" | "fitness_history" | "identity",
        "background" | "fitness_history" | "identity",
        "background" | "fitness_history" | "identity",
        "background" | "fitness_history" | "identity",
        "background" | "fitness_history" | "identity",
        "background" | "fitness_history" | "identity"
      ]
    | [
        "background" | "fitness_history" | "identity",
        "background" | "fitness_history" | "identity",
        "background" | "fitness_history" | "identity",
        "background" | "fitness_history" | "identity",
        "background" | "fitness_history" | "identity",
        "background" | "fitness_history" | "identity",
        "background" | "fitness_history" | "identity",
        "background" | "fitness_history" | "identity"
      ];
  /**
   * @maxItems 512
   */
  source_references: SourceReference[];
  /**
   * @maxItems 128
   */
  conflicts: Conflict[];
  /**
   * @maxItems 512
   */
  retractions: Retraction[];
  /**
   * @minItems 1
   * @maxItems 16
   */
  capabilities:
    | [Capability]
    | [Capability, Capability]
    | [Capability, Capability, Capability]
    | [Capability, Capability, Capability, Capability]
    | [Capability, Capability, Capability, Capability, Capability]
    | [Capability, Capability, Capability, Capability, Capability, Capability]
    | [Capability, Capability, Capability, Capability, Capability, Capability, Capability]
    | [Capability, Capability, Capability, Capability, Capability, Capability, Capability, Capability]
    | [Capability, Capability, Capability, Capability, Capability, Capability, Capability, Capability, Capability]
    | [
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability
      ]
    | [
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability
      ]
    | [
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability
      ]
    | [
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability
      ]
    | [
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability
      ]
    | [
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability
      ]
    | [
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability,
        Capability
      ];
  /**
   * @minItems 1
   * @maxItems 32
   */
  payloads: [Payload, ...Payload[]];
  generated_at: string;
};
export type AllowedPair =
  | {
      producer_id: "stella-runtime";
      consumer_id: "stella-fitness";
      categories?: ("background" | "identity")[];
      capabilities?: {
        id?: "background_context" | "identity_context" | "material_identity_update";
        [k: string]: unknown;
      }[];
      [k: string]: unknown;
    }
  | {
      producer_id: "stella-fitness";
      consumer_id: "stella-runtime";
      categories?: "fitness_history"[];
      capabilities?: {
        id?: "fitness_history_context" | "current_fitness_state";
        [k: string]: unknown;
      }[];
      [k: string]: unknown;
    };
export type Id = string;
export type ProjectionRevision = string;
export type SourceRevision = string;
export type RelativePath = string;
export type Checksum = string;

export interface SourceReference {
  id: Id;
  path: RelativePath;
  revision: SourceRevision;
  checksum: Checksum;
}
export interface Conflict {
  id: Id;
  /**
   * @minItems 2
   * @maxItems 16
   */
  source_reference_ids:
    | [Id, Id]
    | [Id, Id, Id]
    | [Id, Id, Id, Id]
    | [Id, Id, Id, Id, Id]
    | [Id, Id, Id, Id, Id, Id]
    | [Id, Id, Id, Id, Id, Id, Id]
    | [Id, Id, Id, Id, Id, Id, Id, Id]
    | [Id, Id, Id, Id, Id, Id, Id, Id, Id]
    | [Id, Id, Id, Id, Id, Id, Id, Id, Id, Id]
    | [Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id]
    | [Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id]
    | [Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id]
    | [Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id]
    | [Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id]
    | [Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id];
  summary: string;
}
export interface Retraction {
  id: Id;
  source_reference_id: Id;
  retracted_revision: ProjectionRevision;
}
export interface Capability {
  id:
    | "background_context"
    | "fitness_history_context"
    | "identity_context"
    | "material_identity_update"
    | "current_fitness_state";
  state: "available" | "degraded" | "unavailable";
}
export interface Payload {
  path: RelativePath;
  media_type: "application/json" | "text/markdown";
  byte_length: number;
  checksum: Checksum;
}
