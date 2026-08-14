import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  calculateReleasePinChecksum,
  createReleaseProvenance,
  rehearseRecoveryTransport,
  runReleaseConformance,
} from "../../dist/conformance/index.js";

const tarballBytes = Buffer.from("synthetic reproducible release candidate\n");
const tarballIntegrity = `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`;

const releasePin = async (version, _marker) => {
  const fixture = JSON.parse(await readFile(
    new URL("../fixtures/contracts/valid/release-pin.json", import.meta.url),
    "utf8",
  ));
  fixture.package.version = version;
  fixture.package.npm_locator = `${fixture.package.name}@${version}`;
  fixture.package.integrity = tarballIntegrity;
  return fixture;
};

const verifiedReceipt = async (pin) => {
  const receipt = JSON.parse(await readFile(
    new URL("../fixtures/contracts/valid/conformance-receipt.json", import.meta.url),
    "utf8",
  ));
  receipt.package = {
    name: pin.package.name,
    version: pin.package.version,
    integrity: pin.package.integrity,
  };
  receipt.openclaw_version = pin.openclaw.version;
  receipt.provenance.release_pin_sha256 = calculateReleasePinChecksum(pin);
  return receipt;
};

const provenance = createReleaseProvenance({
  sourceRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  lockfile: "synthetic lockfile\n",
  buildCommands: ["npm ci", "npm test", "npm pack --json"],
  tarball: tarballBytes,
  reproducedTarball: tarballBytes,
  expectedIntegrity: tarballIntegrity,
});

const createLifecycle = ({ failOperation } = {}) => {
  const calls = [];
  let installed = null;
  let mode = "off";
  const continuity = {
    activeGeneration: "generation-synthetic-7",
    stateHead: "state-view-synthetic-4",
    pendingOutbox: 1,
    configRevision: "config-synthetic-3",
  };
  return {
    calls,
    async installExact(candidate) {
      assert.equal(candidate.locator, `${candidate.name}@${candidate.version}`);
      calls.push(`install:${candidate.version}`);
      if (failOperation === "upgrade" && candidate.version === "0.1.0-beta.1") {
        throw new Error("PRIVATE_UPGRADE_FAILURE");
      }
      installed = candidate;
      return this.inspect();
    },
    async setMode(nextMode) {
      calls.push(`mode:${nextMode}`);
      if (nextMode === failOperation) throw new Error("PRIVATE_CONSUMER_FAILURE");
      mode = nextMode;
    },
    async probe() {
      calls.push(`probe:${mode}`);
      return {
        runtimeExecuted: mode !== "off",
        cognitiveContextInjected: mode === "enforce",
      };
    },
    async restart() {
      calls.push("restart");
      if (failOperation === "restart") throw new Error("PRIVATE_RESTART_FAILURE");
    },
    async inspect() {
      return {
        packageName: installed?.name ?? "",
        packageVersion: installed?.version ?? "",
        packageIntegrity: installed?.integrity ?? "",
        openclawReleaseChannel: "extended-stable",
        openclawVersion: "2026.6.34",
        capabilityChecksum: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        contractVersions: [
          "cognitive-runtime.runtime-recovery-snapshot-manifest/v2",
          "cognitive-runtime.runtime-recovery-report/v2",
        ],
        compatiblePackageVersions: ["0.1.0-beta.0", "0.1.0-beta.1"],
        compatibleContractVersions: [
          "cognitive-runtime.runtime-recovery-snapshot-manifest/v2",
          "cognitive-runtime.runtime-recovery-report/v2",
        ],
        mode,
        ...continuity,
      };
    },
    async rollbackExact(candidate) {
      assert.equal(candidate.locator, `${candidate.name}@${candidate.version}`);
      calls.push(`rollback:${candidate.version}`);
      installed = candidate;
      mode = "off";
      return this.inspect();
    },
  };
};

test("consumer conformance proves exact upgrade, deployment modes, restart continuity, and rollback", async () => {
  const previous = await releasePin("0.1.0-beta.0", "A");
  const current = await releasePin("0.1.0-beta.1", "B");
  const lifecycle = createLifecycle();

  const receipt = await runReleaseConformance({
    current, previous, previousReceipt: await verifiedReceipt(previous), provenance, lifecycle,
  });

  assert.equal(receipt.status, "pass");
  const { validateContract } = await import("../../dist/contracts/index.js");
  assert.deepEqual(validateContract("conformance-receipt", receipt), {
    valid: true,
    errors: [],
  });
  assert.deepEqual(receipt.scenarios.map(({ id, status }) => [id, status]), [
    ["install", "pass"],
    ["upgrade-compatibility", "pass"],
    ["off", "pass"],
    ["observe", "pass"],
    ["enforce", "pass"],
    ["restart-continuity", "pass"],
    ["rollback", "pass"],
  ]);
  assert.deepEqual(lifecycle.calls, [
    "install:0.1.0-beta.0",
    "install:0.1.0-beta.1",
    "mode:off", "probe:off",
    "mode:observe", "probe:observe",
    "mode:enforce", "probe:enforce",
    "restart",
    "rollback:0.1.0-beta.0",
  ]);
});

test("upgrade, observe, enforce, and restart failures return to the previous verified package", async () => {
  for (const failOperation of ["upgrade", "observe", "enforce", "restart"]) {
    const previous = await releasePin("0.1.0-beta.0", "A");
    const current = await releasePin("0.1.0-beta.1", "B");
    const lifecycle = createLifecycle({ failOperation });

    const receipt = await runReleaseConformance({
      current, previous, previousReceipt: await verifiedReceipt(previous), provenance, lifecycle,
    });

    assert.equal(receipt.status, "fail");
    assert.equal(receipt.scenarios.at(-1).id, "rollback");
    assert.equal(receipt.scenarios.at(-1).status, "pass");
    assert.ok(lifecycle.calls.includes("rollback:0.1.0-beta.0"));
    assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_CONSUMER_FAILURE/);
  }
});

test("conformance rejects an unverified previous release before lifecycle mutation", async () => {
  const previous = await releasePin("0.1.0-beta.0", "A");
  const current = await releasePin("0.1.0-beta.1", "B");
  const previousReceipt = await verifiedReceipt(previous);
  previousReceipt.status = "fail";
  const lifecycle = createLifecycle();

  await assert.rejects(
    runReleaseConformance({ current, previous, previousReceipt, provenance, lifecycle }),
    /PREVIOUS_RELEASE_NOT_VERIFIED/,
  );
  assert.deepEqual(lifecycle.calls, []);
});

test("conformance rejects incomplete previous evidence and unsafe rollback before upgrade", async () => {
  const previous = await releasePin("0.1.0-beta.0", "A");
  const current = await releasePin("0.1.0-beta.1", "B");
  const incompleteReceipt = await verifiedReceipt(previous);
  incompleteReceipt.scenarios.find(({ id }) => id === "observe").status = "fail";
  const lifecycle = createLifecycle();
  await assert.rejects(
    runReleaseConformance({
      current, previous, previousReceipt: incompleteReceipt, provenance, lifecycle,
    }),
    /PREVIOUS_RECEIPT_SCENARIOS_INVALID/,
  );
  assert.deepEqual(lifecycle.calls, []);

  const unsafeLifecycle = createLifecycle();
  const originalInspect = unsafeLifecycle.inspect.bind(unsafeLifecycle);
  unsafeLifecycle.inspect = async () => {
    const inspection = await originalInspect();
    return { ...inspection, compatiblePackageVersions: ["0.1.0-beta.0"] };
  };
  const receipt = await runReleaseConformance({
    current,
    previous,
    previousReceipt: await verifiedReceipt(previous),
    provenance,
    lifecycle: unsafeLifecycle,
  });
  assert.equal(receipt.status, "fail");
  assert.deepEqual(unsafeLifecycle.calls, ["install:0.1.0-beta.0"]);
});

test("conformance rejects conflicting capability and receipt scenario identities", async () => {
  const previous = await releasePin("0.1.0-beta.0", "A");
  const current = await releasePin("0.1.0-beta.1", "B");
  current.openclaw.capabilities.push({ id: "packageInstall", status: "unsupported" });
  const lifecycle = createLifecycle();
  await assert.rejects(
    runReleaseConformance({
      current, previous, previousReceipt: await verifiedReceipt(previous), provenance, lifecycle,
    }),
    /CURRENT_CAPABILITY_ID_DUPLICATE/,
  );
  current.openclaw.capabilities.pop();
  const previousReceipt = await verifiedReceipt(previous);
  previousReceipt.scenarios.push({ ...previousReceipt.scenarios[0], status: "fail" });
  await assert.rejects(
    runReleaseConformance({ current, previous, previousReceipt, provenance, lifecycle }),
    /PREVIOUS_RECEIPT_SCENARIO_ID_DUPLICATE/,
  );
  assert.deepEqual(lifecycle.calls, []);
});

test("conformance rejects caller-constructed invalid provenance before lifecycle mutation", async () => {
  const previous = await releasePin("0.1.0-beta.0", "A");
  const current = await releasePin("0.1.0-beta.1", "B");
  const lifecycle = createLifecycle();
  await assert.rejects(
    runReleaseConformance({
      current,
      previous,
      previousReceipt: await verifiedReceipt(previous),
      provenance: {
        source_revision: "not-a-revision",
        lockfile_sha256: "not-a-checksum",
        build_commands: [],
        reproduced_tarball_sha512: "not-an-integrity",
      },
      lifecycle,
    }),
    /RELEASE_PROVENANCE_INVALID/,
  );
  assert.deepEqual(lifecycle.calls, []);
});

test("recovery orchestrator transports an opaque snapshot through only backup, verify, and restore", async () => {
  const calls = [];
  const opaqueSnapshot = new Proxy({}, {
    get(_target, property) {
      if (property === "then") return undefined;
      throw new Error("opaque snapshot was inspected");
    },
  });
  const source = {
    async backup(options) { calls.push(["backup", options]); return opaqueSnapshot; },
    async verify(snapshot, options) {
      assert.equal(snapshot, opaqueSnapshot);
      calls.push(["verify", options]);
      return { integrity_result: { status: "pass" } };
    },
  };
  const target = {
    async restore(snapshot, options) {
      assert.equal(snapshot, opaqueSnapshot);
      calls.push(["restore", options]);
      return { integrity_result: { status: "pass" } };
    },
  };

  const result = await rehearseRecoveryTransport({
    source,
    target,
    backupOptions: { destinationDirectory: "opaque-destination" },
    verifyOptions: { readOnly: true },
    restoreOptions: { restoreIdempotencyKey: "synthetic-restore" },
  });

  assert.equal(result.verification.integrity_result.status, "pass");
  assert.equal(result.restore.integrity_result.status, "pass");
  assert.deepEqual(calls.map(([operation]) => operation), ["backup", "verify", "restore"]);
});

test("recovery orchestrator maps every private stage failure to bounded reason codes", async () => {
  for (const [stage, reason] of [
    ["backup", "RECOVERY_BACKUP_FAILED"],
    ["verify", "RECOVERY_VERIFY_FAILED"],
    ["restore", "RECOVERY_RESTORE_FAILED"],
  ]) {
    await assert.rejects(
      rehearseRecoveryTransport({
        source: {
          async backup() {
            if (stage === "backup") throw new Error("/private/path/runtime.sqlite");
            return {};
          },
          async verify() {
            if (stage === "verify") throw new Error("PRIVATE_VERIFY_PAYLOAD");
            return {};
          },
        },
        target: {
          async restore() {
            if (stage === "restore") throw new Error("PRIVATE_RESTORE_PAYLOAD");
            return {};
          },
        },
        backupOptions: {}, verifyOptions: {}, restoreOptions: {},
      }),
      (error) => error instanceof Error && error.message === reason,
    );
  }
});
