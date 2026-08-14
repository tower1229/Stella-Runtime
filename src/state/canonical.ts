import { createHash } from "node:crypto";

export interface CanonicalStateValue {
  readonly state_id: string;
  readonly value: unknown;
  readonly source_event_id: string;
}

export const compareCanonicalStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareCanonicalStrings(left, right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
};

export const checksumCanonical = (value: unknown): string =>
  `sha256:${createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex")}`;

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
