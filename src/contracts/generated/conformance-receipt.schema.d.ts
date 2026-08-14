/* Generated from contracts/v2. Do not edit directly. */

export type Integrity = string;
export type Sha256 = string;

export interface ConsumerConformanceReceipt {
  schema_version: "cognitive-runtime.conformance-receipt/v2";
  status: "pass" | "fail";
  package: {
    name: string;
    version: string;
    integrity: Integrity;
  };
  openclaw_version: string;
  /**
   * @minItems 1
   */
  scenarios: [
    {
      id: string;
      status: "pass" | "fail";
      reason_codes: string[];
    },
    ...{
      id: string;
      status: "pass" | "fail";
      reason_codes: string[];
    }[]
  ];
  provenance: {
    tarball_sha512: Integrity;
    reproduced_tarball_sha512: Integrity;
    release_pin_sha256: Sha256;
    source_revision: string;
    lockfile_sha256: Sha256;
    /**
     * @minItems 1
     */
    build_commands: [string, ...string[]];
  };
}
