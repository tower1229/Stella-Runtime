import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyEnvironmentBlock,
  executeVerification,
  resolveVerificationCache,
  VERIFICATION_EXIT,
} from "../../scripts/verification-environment.mjs";
import { verificationProfiles } from "../../scripts/verification-profiles.mjs";

test("verification profiles keep pure work separate from environment capabilities", () => {
  assert.deepEqual(Object.keys(verificationProfiles), [
    "pure",
    "network-install",
    "exact-host",
    "release",
  ]);
  assert.deepEqual(verificationProfiles.pure.requirements, []);
  assert.deepEqual(verificationProfiles["exact-host"].requirements, [
    "network-install",
    "loopback",
    "exact-host",
  ]);
  for (const profile of Object.values(verificationProfiles)) {
    for (const step of profile.steps) {
      if (step.command === process.execPath && step.args.includes("--test")) {
        assert.equal(step.args.includes("--test-concurrency=1"), true);
      }
    }
  }
});

test("verification cache ignores npm injected caches unless explicitly overridden", () => {
  assert.equal(resolveVerificationCache({
    temporaryRoot: "/private/tmp/stella-runtime-verification",
    environment: {
      NPM_CONFIG_CACHE: "/private/tmp/injected-npm-cache",
      npm_config_cache: "/private/tmp/injected-npm-cache",
    },
  }), "/private/tmp/stella-runtime-verification/npm-cache");
  assert.equal(resolveVerificationCache({
    temporaryRoot: "/private/tmp/stella-runtime-verification",
    environment: {
      STELLA_VERIFICATION_NPM_CACHE: "/private/tmp/stella-shared-cache",
    },
  }), "/private/tmp/stella-shared-cache");
  assert.throws(() => resolveVerificationCache({
    temporaryRoot: "/private/tmp/stella-runtime-verification",
    environment: { STELLA_VERIFICATION_NPM_CACHE: "relative-cache" },
  }), /must be an absolute path/);
});

test("only capability-scoped failures become environment blocks", () => {
  assert.equal(classifyEnvironmentBlock({
    output: "Error: listen EPERM: operation not permitted 127.0.0.1",
    requirements: ["loopback"],
  }), "LOOPBACK_PERMISSION_DENIED");
  assert.equal(classifyEnvironmentBlock({
    output: "Error: listen EPERM: operation not permitted 127.0.0.1",
    requirements: [],
  }), null);
  assert.equal(classifyEnvironmentBlock({
    output: "openclaw: Node.js >=24.15.0 <25 is required (current: v24.14.0).",
    requirements: ["exact-host"],
  }), "EXACT_HOST_RUNTIME_INCOMPATIBLE");
});

test("execution stops after a blocked step and returns a machine receipt", async () => {
  const receipts = await executeVerification({
    project: "fixture",
    profileName: "exact-host",
    profiles: {
      "exact-host": {
        requirements: ["loopback"],
        steps: [
          { name: "host", command: "fixture", args: [], requirements: ["loopback"] },
          { name: "never", command: "fixture", args: [] },
        ],
      },
    },
    cwd: "/private/tmp",
    now: () => new Date("2026-08-13T01:00:00.000Z"),
    runStep: async () => ({
      durationMs: 4,
      exitCode: 1,
      output: "listen EPERM 127.0.0.1",
      signal: null,
    }),
    writeLog: () => {},
  });

  assert.equal(receipts.status, "environment_blocked");
  assert.equal(receipts.reasonCode, "LOOPBACK_PERMISSION_DENIED");
  assert.equal(receipts.exitCode, VERIFICATION_EXIT.environmentBlocked);
  assert.equal(receipts.steps.length, 1);
});
