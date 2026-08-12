/* Generated from contracts/v1. Do not edit directly. */

export type ExactVersion = string;
export type Integrity = string;
export type Sha256 = string;

export interface ReleasePin {
  schema_version: "cognitive-runtime.release-pin/v1";
  package: {
    name: string;
    version: ExactVersion;
    npm_locator: string;
    integrity: Integrity;
  };
  /**
   * @minItems 1
   */
  contracts: [string, ...string[]];
  openclaw: {
    release_channel: string;
    version: ExactVersion;
    capability_evidence: string;
    capability_checksum: Sha256;
    /**
     * @minItems 1
     */
    capabilities: [
      {
        id: string;
        status: "pass" | "unsupported";
      },
      ...{
        id: string;
        status: "pass" | "unsupported";
      }[]
    ];
  };
}
