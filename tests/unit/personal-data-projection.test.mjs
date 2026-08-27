import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildRuntimeIdentityProjection,
  canonicalizeProjectionPayload,
  jcsCanonicalJson,
  ProjectionDeterminismLedger,
  runProjectionConsumerConformance,
  runProjectionProducerConformance,
  validateContract,
} from "../../dist/index.js";

test("Runtime identity builder exposes only allowlisted stable identity and fitness fields", () => {
  const publication = buildRuntimeIdentityProjection({
    instanceId: "instance-synthetic",
    canonicalSourceSnapshot: {
      revision: "source-synthetic-identity",
      sourceAsOf: "2026-08-24T00:00:00Z",
    },
    generatedAt: "2026-08-24T00:01:00Z",
    determinismLedger: new ProjectionDeterminismLedger(),
    sourceReferences: [
      {
        id: "source-stella",
        path: "cognitive/cog-stella/entity.md",
        revision: "source-synthetic-identity",
        checksum: `sha256:${"a".repeat(64)}`,
      },
      {
        id: "source-identity",
        path: "semantic/pm-user/claim.md",
        revision: "source-synthetic-identity",
        checksum: `sha256:${"b".repeat(64)}`,
      },
    ],
    sourcePolicies: [
      {
        sourceReferenceId: "source-stella",
        authorityRecordKind: "cognitive",
        dataClasses: ["public_identity"],
        allowedEntryIds: ["stella-identity"],
        sensitivity: "projection_safe",
      },
      {
        sourceReferenceId: "source-identity",
        authorityRecordKind: "personal_model",
        dataClasses: ["public_identity", "stable_fitness_background"],
        allowedEntryIds: [
          "communication-preferences",
          "fitness-training-experience",
          "language",
          "preferred-name",
          "timezone",
        ],
        sensitivity: "projection_safe",
      },
    ],
    context: {
      stellaIdentity: { content: "Stella", sourceReferenceIds: ["source-stella"] },
      preferredName: { content: "朋友", sourceReferenceIds: ["source-identity"] },
      language: { content: "zh-CN", sourceReferenceIds: ["source-identity"] },
      timezone: { content: "Asia/Shanghai", sourceReferenceIds: ["source-identity"] },
      communicationPreferences: {
        content: "直接、务实、先给结论",
        sourceReferenceIds: ["source-identity"],
      },
      stableFitnessBackground: [{
        kind: "training_experience",
        content: "有规律力量训练经验",
        sourceReferenceIds: ["source-identity"],
      }],
    },
  });
  const payload = JSON.parse(publication.payloads[0].bytes.toString("utf8"));
  assert.deepEqual(payload.entries.map(({ id }) => id), [
    "fitness-training-experience",
    "communication-preferences",
    "language",
    "preferred-name",
    "stella-identity",
    "timezone",
  ]);
  assert.equal(JSON.stringify(payload).includes("AGENTS"), false);
  assert.equal(JSON.stringify(payload).includes("secret"), false);

  assert.throws(() => buildRuntimeIdentityProjection({
    instanceId: "instance-synthetic",
    canonicalSourceSnapshot: {
      revision: "source-synthetic-identity",
      sourceAsOf: "2026-08-24T00:00:00Z",
    },
    generatedAt: "2026-08-24T00:01:00Z",
    determinismLedger: new ProjectionDeterminismLedger(),
    sourceReferences: [{
      id: "source-identity",
      path: "semantic/pm-user/claim.md",
      revision: "source-synthetic-identity",
      checksum: `sha256:${"a".repeat(64)}`,
    }],
    sourcePolicies: [{
      sourceReferenceId: "source-identity",
      authorityRecordKind: "personal_model",
      dataClasses: ["public_identity"],
      allowedEntryIds: ["timezone"],
      sensitivity: "projection_safe",
    }],
    context: {
      timezone: { content: "Shanghai", sourceReferenceIds: ["source-identity"] },
    },
  }), /IDENTITY_CONTEXT_TIMEZONE_INVALID/);

  assert.throws(() => buildRuntimeIdentityProjection({
    instanceId: "instance-synthetic",
    canonicalSourceSnapshot: {
      revision: "source-synthetic-identity",
      sourceAsOf: "2026-08-24T00:00:00Z",
    },
    generatedAt: "2026-08-24T00:01:00Z",
    determinismLedger: new ProjectionDeterminismLedger(),
    sourceReferences: [{
      id: "source-agents",
      path: "personal-model/pm-user.md",
      revision: "source-synthetic-identity",
      checksum: `sha256:${"a".repeat(64)}`,
    }],
    sourcePolicies: [{
      sourceReferenceId: "source-agents",
      authorityRecordKind: "personal_model",
      dataClasses: ["public_identity"],
      allowedEntryIds: ["preferred-name"],
      sensitivity: "projection_safe",
    }],
    context: {
      preferredName: { content: "Stella", sourceReferenceIds: ["source-agents"] },
    },
  }), /IDENTITY_CONTEXT_SOURCE_POLICY_FORBIDDEN/);
});

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
  const numbers = Buffer.from(jcsCanonicalJson(vectors.jcs_numbers_escaping.input), "utf8");
  assert.equal(numbers.toString("utf8"), vectors.jcs_numbers_escaping.expected_utf8);
  assert.equal(sha256(numbers), vectors.jcs_numbers_escaping.expected_sha256);
  assert.equal(text.toString("utf8"), vectors.text.expected_utf8);
  assert.equal(sha256(text), vectors.text.expected_sha256);
  assert.deepEqual(vectors.cases.map(({ id }) => id), [
    "array_sorting",
    "duplicate_path",
    "unknown_field",
    "checksum_mismatch",
    "oversize",
    "symlink_path_escape",
    "stale_tuple_mismatch",
  ]);
  for (const vector of vectors.cases.filter(({ fixture }) => fixture !== undefined)) {
    const fixture = JSON.parse(await readFile(
      new URL(`../fixtures/${vector.fixture}`, import.meta.url),
      "utf8",
    ));
    assert.equal(validateContract(vector.contract, fixture).valid, vector.expected_valid);
  }
  const duplicate = vectors.cases.find(({ id }) => id === "duplicate_path");
  assert.throws(() => runProjectionProducerConformance(publicationInput({
    payloads: duplicate.input.payload_paths.map((path) => ({
      ...publicationInput().payloads[0],
      path,
    })),
  })), new RegExp(duplicate.expected_reason));
  const sorting = vectors.cases.find(({ id }) => id === "array_sorting");
  const sorted = runProjectionProducerConformance(publicationInput({
    categories: sorting.input.categories,
    capabilities: sorting.input.capability_ids.map((id) => ({ id, state: "available" })),
  }));
  assert.deepEqual(sorted.manifest.categories, sorting.expected.categories);
  assert.deepEqual(
    sorted.manifest.capabilities.map(({ id }) => id),
    sorting.expected.capability_ids,
  );
  assert.deepEqual(
    JSON.parse(sorted.payloads[0].bytes.toString("utf8")).entries.map(({ id }) => id),
    sorting.expected.identity_entry_ids,
  );
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
  const vectors = JSON.parse(await readFile(
    new URL("../fixtures/projection-conformance/vectors.json", import.meta.url),
    "utf8",
  ));
  const publication = runProjectionProducerConformance(publicationInput());
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
  assert.equal(
    consumed.pointerRevision,
    "pointer-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  assert.equal(consumed.manifestChecksum, publication.manifestChecksum);
  assert.equal(consumed.sourceRevision, publication.manifest.source.revision);

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
  const checksumMismatch = vectors.cases.find(({ id }) => id === "checksum_mismatch");
  damagedPort.readPayload = async () => Buffer.from(
    checksumMismatch.input.actual_utf8,
    "utf8",
  );
  await assert.rejects(runProjectionConsumerConformance({
    instanceId: "instance-synthetic",
    producerId: "stella-runtime",
    consumerId: "stella-fitness",
    purpose: "identity_background",
    port: damagedPort,
  }), /PROJECTION_PAYLOAD_CHECKSUM_MISMATCH/);

  const staleMismatch = vectors.cases.find(({ id }) => id === "stale_tuple_mismatch");
  const mismatchedPointer = pointerBytes(publication, {
    status: staleMismatch.input.status,
    projection_revision: undefined,
    last_verified_revision: publication.projectionRevision,
    source_revision: staleMismatch.input.pointer_source_revision,
    reason_codes: staleMismatch.input.reason_codes,
  });
  await assert.rejects(runProjectionConsumerConformance({
    instanceId: "instance-synthetic",
    producerId: "stella-runtime",
    consumerId: "stella-fitness",
    purpose: "identity_background",
    port: consumerPort(publication, [mismatchedPointer]),
  }), new RegExp(staleMismatch.expected_reason));
});

const publicationInput = (overrides = {}) => ({
  instanceId: "instance-synthetic",
  producerId: "stella-runtime",
  consumerId: "stella-fitness",
  canonicalSourceSnapshot: {
    revision: "source-synthetic-1",
    sourceAsOf: "2026-08-24T00:00:00Z",
  },
  determinismLedger: new ProjectionDeterminismLedger(),
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
    stableId: "runtime-identity-context",
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
      entries: [
        {
          id: "z-entry",
          category: "identity",
          content: "Stella",
          source_reference_ids: ["source-z", "source-a"],
        },
        {
          id: "a-entry",
          category: "background",
          content: "zh-CN",
          source_reference_ids: ["source-user"],
        },
      ],
    },
  }],
  generatedAt: "2026-08-24T00:01:00Z",
  ...overrides,
});

test("producer conformance derives stable revisions from source_as_of and final payload bytes", () => {
  const determinismLedger = new ProjectionDeterminismLedger();
  const first = runProjectionProducerConformance(publicationInput({ determinismLedger }));
  const laterPublication = runProjectionProducerConformance(publicationInput({
    determinismLedger,
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
  const identity = JSON.parse(first.payloads[0].bytes.toString("utf8"));
  assert.deepEqual(identity.categories, ["background", "identity"]);
  assert.deepEqual(identity.entries.map(({ id }) => id), ["a-entry", "z-entry"]);
  assert.deepEqual(identity.entries[1].source_reference_ids, ["source-a", "source-z"]);

  const changedSource = runProjectionProducerConformance(publicationInput({
    determinismLedger,
    canonicalSourceSnapshot: {
      revision: "source-synthetic-2",
      sourceAsOf: "2026-08-24T00:00:00Z",
    },
    payloads: [{
      ...publicationInput().payloads[0],
      value: {
        ...publicationInput().payloads[0].value,
        source_revision: "source-synthetic-2",
      },
    }],
  }));
  assert.notEqual(changedSource.projectionRevision, first.projectionRevision);
  assert.throws(() => runProjectionProducerConformance(publicationInput({
    payloads: [publicationInput().payloads[0], publicationInput().payloads[0]],
  })), /PROJECTION_PAYLOAD_PATH_DUPLICATE/);
  assert.throws(() => runProjectionProducerConformance(publicationInput({
    determinismLedger,
    canonicalSourceSnapshot: {
      revision: "source-synthetic-1",
      sourceAsOf: "2026-08-24T00:00:01Z",
    },
    payloads: [{
      ...publicationInput().payloads[0],
      value: {
        ...publicationInput().payloads[0].value,
        as_of: "2026-08-24T00:00:01Z",
      },
    }],
  })), /PROJECTION_SOURCE_NONDETERMINISTIC/);

  const restoredLedger = new ProjectionDeterminismLedger([
    first.manifest,
    changedSource.manifest,
  ]);
  assert.throws(() => runProjectionProducerConformance(publicationInput({
    determinismLedger: restoredLedger,
    canonicalSourceSnapshot: {
      revision: "source-synthetic-1",
      sourceAsOf: "2026-08-24T00:00:01Z",
    },
    payloads: [{
      ...publicationInput().payloads[0],
      value: {
        ...publicationInput().payloads[0].value,
        as_of: "2026-08-24T00:00:01Z",
      },
    }],
  })), /PROJECTION_SOURCE_NONDETERMINISTIC/);
});
