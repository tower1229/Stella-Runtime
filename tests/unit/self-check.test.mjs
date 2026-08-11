import assert from "node:assert/strict";
import test from "node:test";

import { runSelfCheck } from "../../dist/cli/index.js";

test("self-check reports the scaffold as discoverable", () => {
  assert.deepEqual(runSelfCheck(), {
    status: "ok",
    pluginId: "cognitive-runtime",
  });
});
