import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildProjectionPublication,
  canonicalizeProjectionPayload,
  jcsCanonicalJson,
  runProjectionConsumerConformance,
} from "../../dist/index.js";

const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

test("published conformance vectors pin canonical bytes and the required negative matrix", async () => {
  const vectors = JSON.parse(await readFile(
    new URL("../fixtures/projection-conformance/vectors.json", import.meta.url),
    "utf8",
  ));
  const jcs = Buffer.from(jcsCanonicalJson(vectors.jcs.input), "utf8");
  const text = canonicalizeProjectionPayload(vectors.text.input, "text/markdown");
  assert.equal(jcs.toString("utf8"), vectors.jcs.expected_utf8);
  assert.equal(sha256(jcs), vectors.jcs.expected_sha256);
  assert.equal(text.toString("utf8"), vectors.text.expected_utf8);
  assert.equal(sha256(text), vectors.text.expected_sha256);
  assert.deepEqual(vectors.scenarios, [
    "jcs_numbers_escaping",
    "unicode_nfc",
    "crlf_input",
    "array_sorting",
    "duplicate_path",
    "unknown_field",
    "checksum_mismatch",
    "oversize",
    "symlink_path_escape",
    "stale_tuple_mismatch",
  ]);
});

test("JCS and text payload canonicalization freeze exact final bytes", () => {
  const value = {
    numbers: [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
    string: "€$\u000f\nA'B\"\\\"/",
    literals: [null, true, false],
  };
  assert.equal(
    jcsCanonicalJson(value),
    "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\"/\"}",
  );
  assert.deepEqual(
    canonicalizeProjectionPayload("Cafe\u0301\r\nline two\r\n", "text/markdown"),
    Buffer.from("Café\nline two\n", "utf8"),
  );
  assert.deepEqual(
    canonicalizeProjectionPayload({ z: 1, a: "值" }, "application/json"),
    Buffer.from("{\"a\":\"值\",\"z\":1}", "utf8"),
  );
  assert.throws(() => jcsCanonicalJson({ invalid: Number.NaN }), /JCS_INVALID_NUMBER/);
  assert.throws(() => jcsCanonicalJson({ invalid: "\ud800" }), /JCS_INVALID_UNICODE/);
});

const pointerBytes = (publication, overrides = {}) => Buffer.from(jcsCanonicalJson(Object.fromEntries(Object.entries({
  schema_version: "stella.context-projection-pointer/v1",
  instance_id: "instance-synthetic",
  producer_id: "stella-runtime",
  consumer_id: "stella-fitness",
  status: "active",
  pointer_revision: "pointer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  projection_revision: publication.projectionRevision,
  manifest_checksum: publication.manifestChecksum,
  source_revision: publication.manifest.source.revision,
  as_of: publication.manifest.source.as_of,
  changed_at: "2026-08-24T00:02:00Z",
  ...overrides,
}).filter(([, value]) => value !== undefined))), "utf8");

const consumerPort = (publication, pointers) => {
  let pointerRead = 0;
  return {
    async readPointer() {
      return pointers[Math.min(pointerRead++, pointers.length - 1)];
    },
    async readManifest(revision) {
      assert.equal(revision, publication.projectionRevision);
      return publication.manifestBytes;
    },
    async readPayload(revision, path) {
      assert.equal(revision, publication.projectionRevision);
      return publication.payloads.find((payload) => payload.path === path).bytes;
    },
  };
};

test("consumer conformance double-reads the pointer and enforces active/stale policy", async () => {
  const publication = buildProjectionPublication(publicationInput());
  const active = pointerBytes(publication);
  const consumed = await runProjectionConsumerConformance({
    instanceId: "instance-synthetic",
    producerId: "stella-runtime",
    consumerId: "stella-fitness",
    purpose: "identity_background",
    port: consumerPort(publication, [active]),
  });
  assert.equal(consumed.status, "active");
  assert.equal(consumed.projectionRevision, publication.projectionRevision);

  const stale = pointerBytes(publication, {
    status: "stale",
    projection_revision: undefined,
    last_verified_revision: publication.projectionRevision,
    reason_codes: ["REFRESH_FAILED"],
  });
  assert.equal((await runProjectionConsumerConformance({
    instanceId: "instance-synthetic",
    producerId: "stella-runtime",
    consumerId: "stella-fitness",
    purpose: "identity_background",
    port: consumerPort(publication, [stale]),
  })).status, "stale");
  await assert.rejects(runProjectionConsumerConformance({
    instanceId: "instance-synthetic",
    producerId: "stella-runtime",
    consumerId: "stella-fitness",
    purpose: "material_identity_update",
    port: consumerPort(publication, [stale]),
  }), /PROJECTION_STALE_FORBIDDEN/);

  const changed = pointerBytes(publication, {
    pointer_revision: "pointer-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });
  await assert.rejects(runProjectionConsumerConformance({
    instanceId: "instance-synthetic",
    producerId: "stella-runtime",
    consumerId: "stella-fitness",
    purpose: "identity_background",
    port: consumerPort(publication, [active, changed]),
  }), /PROJECTION_POINTER_CHANGED/);

  const blocked = pointerBytes(publication, {
    status: "blocked",
    projection_revision: undefined,
    manifest_checksum: undefined,
    as_of: undefined,
    reason_codes: ["SOURCE_CONFLICT"],
  });
  await assert.rejects(runProjectionConsumerConformance({
    instanceId: "instance-synthetic",
    producerId: "stella-runtime",
    consumerId: "stella-fitness",
    purpose: "identity_background",
    port: consumerPort(publication, [blocked]),
  }), /PROJECTION_NOT_CONSUMABLE/);

  const damagedPort = consumerPort(publication, [active]);
  damagedPort.readPayload = async () => Buffer.from("{}", "utf8");
  await assert.rejects(runProjectionConsumerConformance({
    instanceId: "instance-synthetic",
    producerId: "stella-runtime",
    consumerId: "stella-fitness",
    purpose: "identity_background",
    port: damagedPort,
  }), /PROJECTION_PAYLOAD_CHECKSUM_MISMATCH/);
});

const publicationInput = (overrides = {}) => ({
  instanceId: "instance-synthetic",
  producerId: "stella-runtime",
  consumerId: "stella-fitness",
  sourceRevision: "source-synthetic-1",
  sourceAsOf: "2026-08-24T00:00:00Z",
  categories: ["identity", "background"],
  sourceReferences: [
    {
      id: "source-user",
      path: "authority/user.md",
      revision: "source-synthetic-1",
      checksum: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  ],
  conflicts: [],
  retractions: [],
  capabilities: [
    { id: "identity_context", state: "available" },
    { id: "background_context", state: "available" },
  ],
  payloads: [{
    path: "payloads/identity-context.json",
    mediaType: "application/json",
    value: {
      schema_version: "stella.identity-context/v1",
      instance_id: "instance-synthetic",
      producer_id: "stella-runtime",
      consumer_id: "stella-fitness",
      source_revision: "source-synthetic-1",
      as_of: "2026-08-24T00:00:00Z",
      categories: ["background", "identity"],
      entries: [],
    },
  }],
  generatedAt: "2026-08-24T00:01:00Z",
  ...overrides,
});

test("producer conformance derives stable revisions from source_as_of and final payload bytes", () => {
  const first = buildProjectionPublication(publicationInput());
  const laterPublication = buildProjectionPublication(publicationInput({
    generatedAt: "2026-08-24T12:00:00Z",
    categories: ["background", "identity"],
    capabilities: [
      { id: "background_context", state: "available" },
      { id: "identity_context", state: "available" },
    ],
  }));

  assert.equal(first.projectionRevision, laterPublication.projectionRevision);
  assert.equal(first.payloads[0].checksum, laterPublication.payloads[0].checksum);
  assert.notEqual(first.manifestChecksum, laterPublication.manifestChecksum);
  assert.deepEqual(first.manifest.categories, ["background", "identity"]);
  assert.deepEqual(first.manifest.capabilities.map(({ id }) => id), [
    "background_context",
    "identity_context",
  ]);

  const changedSource = buildProjectionPublication(publicationInput({
    sourceRevision: "source-synthetic-2",
    payloads: [{
      ...publicationInput().payloads[0],
      value: {
        ...publicationInput().payloads[0].value,
        source_revision: "source-synthetic-2",
      },
    }],
  }));
  assert.notEqual(changedSource.projectionRevision, first.projectionRevision);
  assert.throws(() => buildProjectionPublication(publicationInput({
    payloads: [publicationInput().payloads[0], publicationInput().payloads[0]],
  })), /PROJECTION_PAYLOAD_PATH_DUPLICATE/);
});
