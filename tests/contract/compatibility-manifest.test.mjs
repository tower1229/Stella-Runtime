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
  assert.equal(manifest.packageVersion, "0.2.1");
  assert.equal(manifest.hosts.length, 1);
  assert.equal(manifest.hosts[0].releaseChannel, "extended-stable");
  assert.equal(manifest.hosts[0].openclawVersion, "2026.6.34");
  assert.equal(manifest.hosts[0].nodeVersion, "24.18.0");
  assert.doesNotMatch(manifest.hosts[0].openclawVersion, /[<>=~^*]/);
  assert.doesNotMatch(manifest.hosts[0].nodeVersion, /[<>=~^*]/);
  assert.deepEqual(manifest.hosts[0].generationConsumptionAcceptance, {
    status: "passed",
    profile: "packed-exact-host",
    scenarios: [
      "approved-publication-to-next-eligible-run",
      "host-config-mutation-failure",
      "index-failure",
      "search-sentinel-failure",
      "process-interruption",
      "stale-receipt",
      "config-or-index-drift",
    ],
  });
  assert.equal(
    manifest.hosts[0].capabilityExpectations.typedHooks.status,
    "required",
  );
  assert.deepEqual(
    manifest.hosts[0].capabilityExpectations.typedHooks.hooks,
    [
      "before_agent_run",
      "before_prompt_build",
      "after_tool_call",
      "before_agent_finalize",
      "agent_end",
    ],
  );
  assert.equal(
    manifest.hosts[0].capabilityExpectations.runContextRoundTrip.status,
    "unsupported",
  );
  assert.doesNotMatch(JSON.stringify(manifest), /minimumVersion/i);
});
