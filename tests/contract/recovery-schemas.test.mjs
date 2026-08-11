import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSchema = async (name) =>
  JSON.parse(
    await readFile(
      new URL(`../../contracts/v1/${name}.schema.json`, import.meta.url),
      "utf8",
    ),
  );

test("recovery snapshot manifest freezes the authoritative state boundary", async () => {
  const schema = await readSchema("runtime-recovery-snapshot-manifest");

  assert.equal(
    schema.$id,
    "cognitive-runtime.runtime-recovery-snapshot-manifest/v1",
  );
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "snapshot_schema_version",
    "storage_schema_version",
    "package_version",
    "contract_version",
    "instance_id",
    "authority_revision",
    "state_boundary",
    "files",
    "pending_outbox_summary",
    "created_at",
    "projections_requiring_rebuild",
  ]);
  assert.deepEqual(schema.properties.state_boundary.required, [
    "active_seq",
    "state_view_version",
    "checksum",
  ]);
  assert.deepEqual(schema.properties.files.items.required, [
    "path",
    "size",
    "checksum",
  ]);
});

test("recovery report exposes compatibility, integrity, restore, and rollback outcomes", async () => {
  const schema = await readSchema("runtime-recovery-report");

  assert.equal(
    schema.$id,
    "cognitive-runtime.runtime-recovery-report/v1",
  );
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "report_schema_version",
    "operation",
    "authority_revision",
    "compatibility_result",
    "integrity_result",
    "restored_active_head",
    "pending_outbox_state",
    "storage_migrations_applied",
    "rollback_result",
    "projections_requiring_rebuild",
  ]);
});
