import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("compatibility is declared for one channel and exact host version", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../../compatibility/openclaw.json", import.meta.url),
      "utf8",
    ),
  );

  assert.equal(
    manifest.schemaVersion,
    "cognitive-runtime.openclaw-compatibility/v2",
  );
  assert.equal(manifest.hosts.length, 1);
  assert.equal(manifest.hosts[0].releaseChannel, "extended-stable");
  assert.equal(manifest.hosts[0].openclawVersion, "2026.6.34");
  assert.doesNotMatch(manifest.hosts[0].openclawVersion, /[<>=~^*]/);
  assert.equal(
    manifest.hosts[0].capabilityExpectations.typedHooks.status,
    "required",
  );
  assert.equal(
    manifest.hosts[0].capabilityExpectations.runContextRoundTrip.status,
    "unsupported",
  );
  assert.doesNotMatch(JSON.stringify(manifest), /minimumVersion/i);
});
