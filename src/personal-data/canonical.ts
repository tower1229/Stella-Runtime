const assertUnicodeScalarString = (value: string): void => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new Error("JCS_INVALID_UNICODE");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("JCS_INVALID_UNICODE");
    }
  }
};

const serializeJcs = (value: unknown): string => {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    assertUnicodeScalarString(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("JCS_INVALID_NUMBER");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        throw new Error("JCS_INVALID_VALUE");
      }
      items.push(serializeJcs(value[index]));
    }
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("JCS_INVALID_VALUE");
    }
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries.map(([key, child]) => {
      assertUnicodeScalarString(key);
      return `${JSON.stringify(key)}:${serializeJcs(child)}`;
    }).join(",")}}`;
  }
  throw new Error("JCS_INVALID_VALUE");
};

export function jcsCanonicalJson(value: unknown): string {
  return serializeJcs(value);
}

export type ProjectionPayloadMediaType = "application/json" | "text/markdown";

export function canonicalizeProjectionPayload(
  value: unknown,
  mediaType: ProjectionPayloadMediaType,
): Buffer {
  if (mediaType === "application/json") {
    return Buffer.from(jcsCanonicalJson(value), "utf8");
  }
  if (typeof value !== "string") {
    throw new Error("PROJECTION_TEXT_PAYLOAD_INVALID");
  }
  if (value.startsWith("\ufeff")) {
    throw new Error("PROJECTION_PAYLOAD_BOM_FORBIDDEN");
  }
  const normalized = value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .normalize("NFC")
    .replace(/\n+$/u, "");
  assertUnicodeScalarString(normalized);
  return Buffer.from(`${normalized}\n`, "utf8");
}
