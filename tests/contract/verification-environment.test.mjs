import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  classifyEnvironmentBlock,
  executeVerification,
  resolveVerificationCache,
  VERIFICATION_EXIT,
} from "../../scripts/verification-environment.mjs";
import { verificationProfiles } from "../../scripts/verification-profiles.mjs";
import {
  loadVerificationReceipts,
  persistVerificationReceipt,
} from "../../scripts/verification-receipt.mjs";

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

test("source-bound verification receipts persist atomically and reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "stella-verification-receipt-"));
  const profiles = {
    pure: {
      requirements: [],
      steps: [{ name: "fixture", command: "fixture", args: [] }],
    },
    release: {
      requirements: [],
      steps: [
        { name: "first", command: "fixture", args: [] },
        { name: "second", command: "fixture", args: [] },
      ],
    },
  };
  try {
    const persisted = await persistVerificationReceipt({
      receipt: {
        schemaVersion: "verification-environment/v1",
        project: "fixture",
        profile: "pure",
        status: "passed",
        exitCode: 0,
        startedAt: "2026-08-13T01:00:00.000Z",
        finishedAt: "2026-08-13T01:00:01.000Z",
        steps: [{
          name: "fixture",
          status: "passed",
          exitCode: 0,
          durationMs: 1,
        }],
      },
      cwd: root,
      sourceState: { revision: "abc123", clean: true },
      profile: profiles.pure,
    });
    assert.equal(persisted.relativePath, ".stella/verification/pure.json");
    assert.equal(
      JSON.parse(await readFile(persisted.path, "utf8")).sourceRevision,
      "abc123",
    );
    assert.equal(persisted.receipt.sourceClean, true);
    assert.deepEqual(await loadVerificationReceipts({
      cwd: root,
      project: "fixture",
      profiles,
    }), {
      receipts: [persisted.receipt],
      invalidFiles: [],
    });
    await writeFile(join(root, ".stella/verification/broken.json"), "not json\n");
    await writeFile(join(root, ".stella/verification/failed.json"), JSON.stringify({
      ...persisted.receipt,
      profile: "failed",
      status: "passed",
      exitCode: 1,
    }));
    await writeFile(join(root, ".stella/verification/foreign.json"), JSON.stringify({
      ...persisted.receipt,
      profile: "foreign",
      project: "another-project",
    }));
    const release = await persistVerificationReceipt({
      receipt: {
        ...persisted.receipt,
        profile: "release",
        steps: profiles.release.steps.map((step) => ({
          name: step.name,
          status: "passed",
          exitCode: 0,
          durationMs: 1,
        })),
      },
      cwd: root,
      sourceState: { revision: "abc123", clean: true },
      profile: profiles.release,
    });
    await writeFile(release.path, JSON.stringify({
      ...release.receipt,
      steps: release.receipt.steps.slice(0, 1),
    }));
    assert.deepEqual(
      (await loadVerificationReceipts({ cwd: root, project: "fixture", profiles })).invalidFiles,
      ["broken.json", "failed.json", "foreign.json", "release.json"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a blocked profile prefix remains a valid structured receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "stella-blocked-receipt-"));
  const profiles = {
    "exact-host": {
      requirements: ["exact-host"],
      steps: [
        { name: "build", command: "fixture", args: [] },
        { name: "host", command: "fixture", args: [], requirements: ["exact-host"] },
        { name: "never", command: "fixture", args: [] },
      ],
    },
  };
  try {
    await persistVerificationReceipt({
      receipt: {
        schemaVersion: "verification-environment/v1",
        project: "fixture",
        profile: "exact-host",
        status: "environment_blocked",
        reasonCode: "EXACT_HOST_UNAVAILABLE",
        exitCode: 3,
        startedAt: "2026-08-13T01:00:00.000Z",
        finishedAt: "2026-08-13T01:00:01.000Z",
        steps: [
          { name: "build", status: "passed", exitCode: 0, durationMs: 1 },
          {
            name: "host",
            status: "environment_blocked",
            reasonCode: "EXACT_HOST_UNAVAILABLE",
            exitCode: 1,
            durationMs: 1,
          },
        ],
      },
      cwd: root,
      sourceState: { revision: "abc123", clean: true },
      profile: profiles["exact-host"],
    });
    const loaded = await loadVerificationReceipts({
      cwd: root,
      project: "fixture",
      profiles,
    });
    assert.equal(loaded.invalidFiles.length, 0);
    assert.equal(loaded.receipts[0].reasonCode, "EXACT_HOST_UNAVAILABLE");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
