/* Generated from contracts/stella/v1. Do not edit directly. */

export type StellaContextProjectionPointer = AllowedPair & {
  [k: string]: unknown;
} & {
  schema_version: "stella.context-projection-pointer/v1";
  instance_id: Id;
  producer_id: "stella-runtime" | "stella-fitness";
  consumer_id: "stella-fitness" | "stella-runtime";
  status: "active" | "stale" | "blocked" | "revoked";
  pointer_revision: PointerRevision;
  projection_revision?: ProjectionRevision;
  last_verified_revision?: ProjectionRevision;
  manifest_checksum?: Checksum;
  source_revision: SourceRevision;
  as_of?: string;
  changed_at: string;
  /**
   * @minItems 1
   * @maxItems 16
   */
  reason_codes?:
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ];
};
export type AllowedPair =
  | {
      producer_id: "stella-runtime";
      consumer_id: "stella-fitness";
      [k: string]: unknown;
    }
  | {
      producer_id: "stella-fitness";
      consumer_id: "stella-runtime";
      [k: string]: unknown;
    };
export type Id = string;
export type PointerRevision = string;
export type ProjectionRevision = string;
export type Checksum = string;
export type SourceRevision = string;
