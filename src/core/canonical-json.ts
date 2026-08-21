import { createHash } from "node:crypto";

export interface CanonicalJsonOptions {
  readonly invalidValueReason?: string;
  readonly trailingNewline?: boolean;
}

export const compareCanonicalStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const invalidValue = (reason: string | undefined): never => {
  throw new Error(reason ?? "CANONICAL_JSON_INVALID");
};

export const canonicalizeJson = (
  value: unknown,
  options: Pick<CanonicalJsonOptions, "invalidValueReason"> = {},
): unknown => {
  const strict = options.invalidValueReason !== undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return strict && !Number.isFinite(value)
      ? invalidValue(options.invalidValueReason)
      : value;
  }
  if (Array.isArray(value)) {
    if (strict) {
      return Array.from(value, (child) => canonicalizeJson(child, options));
    }
    return value.map((child) => canonicalizeJson(child, options));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareCanonicalStrings(left, right))
        .map(([key, child]) => [key, canonicalizeJson(child, options)]),
    );
  }
  return strict ? invalidValue(options.invalidValueReason) : value;
};

export const canonicalJson = (
  value: unknown,
  options: CanonicalJsonOptions = {},
): string => {
  const serialized = JSON.stringify(canonicalizeJson(value, options));
  if (serialized === undefined) return invalidValue(options.invalidValueReason);
  return options.trailingNewline === true ? `${serialized}\n` : serialized;
};

export const canonicalJsonEqual = (left: unknown, right: unknown): boolean =>
  canonicalJson(left) === canonicalJson(right);

export const checksumCanonicalJson = (
  value: unknown,
  options: CanonicalJsonOptions = {},
): string => `sha256:${createHash("sha256").update(canonicalJson(value, options)).digest("hex")}`;
