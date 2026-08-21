import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canonicalJson,
  canonicalJsonEqual,
  canonicalizeJson,
  checksumCanonicalJson,
} from "../../dist/core/canonical-json.js";

test("canonical JSON uses deterministic lexical key ordering", () => {
  const value = { "é": 1, z: { b: 2, a: 1 }, a: 0 };
  assert.equal(canonicalJson(value), '{"a":0,"z":{"a":1,"b":2},"é":1}');
  assert.equal(canonicalJson(value, { trailingNewline: true }), '{"a":0,"z":{"a":1,"b":2},"é":1}\n');
  assert.equal(canonicalJsonEqual(value, { a: 0, "é": 1, z: { a: 1, b: 2 } }), true);
  assert.match(checksumCanonicalJson(value), /^sha256:[a-f0-9]{64}$/);
});

test("canonical JSON can reject values outside JSON with a domain error", () => {
  assert.throws(
    () => canonicalizeJson({ invalid: undefined }, { invalidValueReason: "DOMAIN_JSON_INVALID" }),
    /DOMAIN_JSON_INVALID/,
  );
  assert.throws(
    () => canonicalizeJson(Number.NaN, { invalidValueReason: "DOMAIN_JSON_INVALID" }),
    /DOMAIN_JSON_INVALID/,
  );
});
