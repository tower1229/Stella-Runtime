import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTHORITATIVE_RUNTIME_STATE_CONTENTS,
  RUNTIME_RECOVERY_SNAPSHOT_EXCLUDED_CONTENTS,
} from "../../dist/recovery/index.js";

test("recovery contract freezes authoritative and rebuildable/private classifications", () => {
  assert.deepEqual(AUTHORITATIVE_RUNTIME_STATE_CONTENTS, [
    "current_state_event_ledger",
    "active_state_head",
    "unfinished_corrections",
    "reanswer_outbox",
    "storage_schema_version",
  ]);
  assert.deepEqual(RUNTIME_RECOVERY_SNAPSHOT_EXCLUDED_CONTENTS, [
    "state_view",
    "generation",
    "registry",
    "index",
    "cache",
    "credentials",
    "cognitive_provenance_overlay",
    "logs",
    "raw_experience_records",
    "authority_documents",
  ]);
});
