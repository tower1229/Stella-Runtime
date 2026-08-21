import {
  canonicalizeJson,
  checksumCanonicalJson,
  compareCanonicalStrings,
} from "../core/canonical-json.js";

export interface CanonicalStateValue {
  readonly state_id: string;
  readonly value: unknown;
  readonly source_event_id: string;
}

export { compareCanonicalStrings };

export const canonicalize = canonicalizeJson;

export const checksumCanonical = checksumCanonicalJson;

export const calculateStateViewChecksum = (
  instanceId: string,
  activeSeq: number,
  values: readonly CanonicalStateValue[],
): string => checksumCanonical({
  instance_id: instanceId,
  active_seq: activeSeq,
  values: [...values].sort((left, right) =>
    compareCanonicalStrings(left.state_id, right.state_id)),
});

export const stateViewVersion = (activeSeq: number, checksum: string): string =>
  `state-view-${activeSeq}-${checksum.slice(7, 19)}`;
