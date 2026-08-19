import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveCompatibilityMatrixRow,
} from "../../dist/compatibility/index.js";

test("Compatibility Matrix authorizes one exact smoked OpenClaw and Node row", async () => {
  assert.deepEqual(await resolveCompatibilityMatrixRow({
    openclawVersion: "2026.6.34",
    nodeVersion: "24.18.0",
  }), {
    releaseChannel: "extended-stable",
    openclawVersion: "2026.6.34",
    nodeVersion: "24.18.0",
    evidence: "docs/evidence/openclaw-2026.6.34.md",
  });
});

test("an engine-compatible but unsmoked Node version is incompatible", async () => {
  await assert.rejects(
    resolveCompatibilityMatrixRow({
      openclawVersion: "2026.6.34",
      nodeVersion: "24.17.0",
    }),
    { message: "INCOMPATIBLE_HOST" },
  );
});
