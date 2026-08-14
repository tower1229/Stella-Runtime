import { createHash } from "node:crypto";

import type {
  ConsumerConformanceReceipt,
  ReleasePin,
} from "../contracts/index.js";
import { validateContract } from "../contracts/index.js";

const DEPLOYMENT_MODES = ["off", "observe", "enforce"] as const;
type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

export interface ReleaseInspection {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly packageIntegrity: string;
  readonly openclawReleaseChannel: string;
  readonly openclawVersion: string;
  readonly capabilityChecksum: string;
  readonly contractVersions: readonly string[];
  readonly compatiblePackageVersions: readonly string[];
  readonly compatibleContractVersions: readonly string[];
  readonly mode: DeploymentMode;
  readonly activeGeneration: string;
  readonly stateHead: string;
  readonly pendingOutbox: number;
  readonly configRevision: string;
}

export interface ExactNpmRelease {
  readonly locator: string;
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
}

export interface ReleaseLifecyclePort {
  installExact(candidate: ExactNpmRelease): Promise<ReleaseInspection>;
  setMode(mode: DeploymentMode): Promise<void>;
  probe(): Promise<{
    readonly runtimeExecuted: boolean;
    readonly cognitiveContextInjected: boolean;
  }>;
  restart(): Promise<void>;
  inspect(): Promise<ReleaseInspection>;
  rollbackExact(candidate: ExactNpmRelease): Promise<ReleaseInspection>;
}

export interface ReleaseConformanceOptions {
  readonly current: ReleasePin;
  readonly previous: ReleasePin;
  readonly previousReceipt: ConsumerConformanceReceipt;
  readonly provenance: Pick<
    ConsumerConformanceReceipt["provenance"],
    "source_revision" | "lockfile_sha256" | "build_commands" | "reproduced_tarball_sha512"
  >;
  readonly lifecycle: ReleaseLifecyclePort;
}

export function createReleaseProvenance(options: {
  readonly sourceRevision: string;
  readonly lockfile: string | Uint8Array;
  readonly buildCommands: readonly string[];
  readonly tarball: Uint8Array;
  readonly reproducedTarball: Uint8Array;
  readonly expectedIntegrity: string;
}): ReleaseConformanceOptions["provenance"] {
  if (!/^[a-f0-9]{40}$/.test(options.sourceRevision)) {
    throw new Error("SOURCE_REVISION_INVALID");
  }
  const [firstCommand, ...remainingCommands] = options.buildCommands;
  if (firstCommand === undefined || options.buildCommands.some(
    (command) => command.length === 0,
  )) {
    throw new Error("BUILD_COMMANDS_INVALID");
  }
  const tarballIntegrity = `sha512-${createHash("sha512")
    .update(options.tarball).digest("base64")}`;
  const reproducedIntegrity = `sha512-${createHash("sha512")
    .update(options.reproducedTarball).digest("base64")}`;
  if (
    tarballIntegrity !== options.expectedIntegrity
    || reproducedIntegrity !== options.expectedIntegrity
  ) {
    throw new Error("TARBALL_REPRODUCTION_MISMATCH");
  }
  return {
    source_revision: options.sourceRevision,
    lockfile_sha256: `sha256:${createHash("sha256").update(options.lockfile).digest("hex")}`,
    build_commands: [firstCommand, ...remainingCommands],
    reproduced_tarball_sha512: reproducedIntegrity,
  };
}

export function calculateReleasePinChecksum(pin: ReleasePin): string {
  return releasePinChecksum(pin);
}

const assertProvenance = (
  provenance: ReleaseConformanceOptions["provenance"],
): void => {
  if (
    !/^[a-f0-9]{40}$/.test(provenance.source_revision)
    || !/^sha256:[a-f0-9]{64}$/.test(provenance.lockfile_sha256)
    || provenance.build_commands.length === 0
    || provenance.build_commands.some((command) => command.length === 0)
    || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(provenance.reproduced_tarball_sha512)
  ) {
    throw new Error("RELEASE_PROVENANCE_INVALID");
  }
};

type ScenarioReceipt = ConsumerConformanceReceipt["scenarios"][number];

const canonicalize = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
};

const releasePinChecksum = (pin: ReleasePin): string =>
  `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalize(pin)))
    .digest("hex")}`;

const assertReleasePin = (pin: ReleasePin, label: string): void => {
  if (!validateContract("release-pin", pin).valid) {
    throw new Error(`${label}_RELEASE_PIN_INVALID`);
  }
  if (pin.package.npm_locator !== `${pin.package.name}@${pin.package.version}`) {
    throw new Error(`${label}_NPM_LOCATOR_MISMATCH`);
  }
  const requiredCapabilities = [
    "packageInstall",
    "runtimeInspect",
    "typedHooks",
    "modelCompletion",
    "memoryReferences",
    "successorDelivery",
    "cleanup",
    "failurePaths",
  ];
  const capabilityStatus = new Map(
    pin.openclaw.capabilities.map(({ id, status }) => [id, status]),
  );
  if (capabilityStatus.size !== pin.openclaw.capabilities.length) {
    throw new Error(`${label}_CAPABILITY_ID_DUPLICATE`);
  }
  if (!requiredCapabilities.every((id) => capabilityStatus.get(id) === "pass")) {
    throw new Error(`${label}_CAPABILITY_RESULT_INCOMPLETE`);
  }
};

const assertPreviousVerified = (
  pin: ReleasePin,
  receipt: ConsumerConformanceReceipt,
): void => {
  if (
    !validateContract("conformance-receipt", receipt).valid
    || receipt.status !== "pass"
    || receipt.package.name !== pin.package.name
    || receipt.package.version !== pin.package.version
    || receipt.package.integrity !== pin.package.integrity
    || receipt.openclaw_version !== pin.openclaw.version
    || receipt.provenance.release_pin_sha256 !== releasePinChecksum(pin)
  ) {
    throw new Error("PREVIOUS_RELEASE_NOT_VERIFIED");
  }
  if (new Set(receipt.scenarios.map(({ id }) => id)).size !== receipt.scenarios.length) {
    throw new Error("PREVIOUS_RECEIPT_SCENARIO_ID_DUPLICATE");
  }
  const expectedScenarios = [
    "install",
    "upgrade-compatibility",
    "off",
    "observe",
    "enforce",
    "restart-continuity",
    "rollback",
  ];
  if (
    receipt.scenarios.length !== expectedScenarios.length
    || !expectedScenarios.every((id) => receipt.scenarios.some(
      (scenario) => scenario.id === id
        && scenario.status === "pass"
        && scenario.reason_codes.length === 0,
    ))
  ) {
    throw new Error("PREVIOUS_RECEIPT_SCENARIOS_INVALID");
  }
};

const exactNpmRelease = (pin: ReleasePin): ExactNpmRelease => ({
  locator: pin.package.npm_locator,
  name: pin.package.name,
  version: pin.package.version,
  integrity: pin.package.integrity,
});

const assertInstalled = (
  inspection: ReleaseInspection,
  pin: ReleasePin,
): void => {
  if (
    inspection.packageName !== pin.package.name
    || inspection.packageVersion !== pin.package.version
    || inspection.packageIntegrity !== pin.package.integrity
  ) {
    throw new Error("PACKAGE_PIN_MISMATCH");
  }
  if (inspection.openclawVersion !== pin.openclaw.version) {
    throw new Error("OPENCLAW_VERSION_MISMATCH");
  }
  if (
    inspection.openclawReleaseChannel !== pin.openclaw.release_channel
    || inspection.capabilityChecksum !== pin.openclaw.capability_checksum
  ) {
    throw new Error("OPENCLAW_CAPABILITY_PIN_MISMATCH");
  }
  if (!pin.contracts.every((version) => inspection.contractVersions.includes(version))) {
    throw new Error("CONTRACT_VERSION_MISMATCH");
  }
};

const sameContinuity = (
  before: ReleaseInspection,
  after: ReleaseInspection,
): boolean =>
  before.activeGeneration === after.activeGeneration
  && before.stateHead === after.stateHead
  && before.pendingOutbox === after.pendingOutbox
  && before.configRevision === after.configRevision
  && before.mode === after.mode;

const pass = (id: string): ScenarioReceipt => ({
  id,
  status: "pass",
  reason_codes: [],
});

const fail = (id: string, reasonCode: string): ScenarioReceipt => ({
  id,
  status: "fail",
  reason_codes: [reasonCode],
});

const reasonCodeFor = (scenario: string, error: unknown): string => {
  const message = error instanceof Error ? error.message : "";
  const publicReasons = new Set([
    "PACKAGE_PIN_MISMATCH",
    "OPENCLAW_VERSION_MISMATCH",
    "OPENCLAW_CAPABILITY_PIN_MISMATCH",
    "CONTRACT_VERSION_MISMATCH",
    "PREVIOUS_PACKAGE_INCOMPATIBLE",
    "PREVIOUS_CONTRACTS_INCOMPATIBLE",
    "ROLLBACK_SCHEMA_INCOMPATIBLE",
    "OFF_BEHAVIOR_MISMATCH",
    "OBSERVE_BEHAVIOR_MISMATCH",
    "ENFORCE_BEHAVIOR_MISMATCH",
    "RESTART_CONTINUITY_MISMATCH",
    "ROLLBACK_CONTINUITY_MISMATCH",
  ]);
  if (publicReasons.has(message)) {
    return message;
  }
  return `${scenario.replaceAll("-", "_").toUpperCase()}_FAILED`;
};

const assertProbe = (
  mode: DeploymentMode,
  probe: Awaited<ReturnType<ReleaseLifecyclePort["probe"]>>,
): void => {
  const expectedExecution = mode !== "off";
  const expectedInjection = mode === "enforce";
  if (
    probe.runtimeExecuted !== expectedExecution
    || probe.cognitiveContextInjected !== expectedInjection
  ) {
    throw new Error(`${mode.toUpperCase()}_BEHAVIOR_MISMATCH`);
  }
};

export async function runReleaseConformance(
  options: ReleaseConformanceOptions,
): Promise<ConsumerConformanceReceipt> {
  assertReleasePin(options.previous, "PREVIOUS");
  assertReleasePin(options.current, "CURRENT");
  assertPreviousVerified(options.previous, options.previousReceipt);
  assertProvenance(options.provenance);
  if (
    options.previous.package.name !== options.current.package.name
    || options.previous.package.version === options.current.package.version
  ) {
    throw new Error("UPGRADE_PIN_INVALID");
  }

  const scenarios: ScenarioReceipt[] = [];
  let activeScenario = "install";
  let failed = false;
  let previousInstalled: ReleaseInspection | null = null;
  let currentInstallAttempted = false;
  try {
    previousInstalled = await options.lifecycle.installExact(exactNpmRelease(options.previous));
    assertInstalled(previousInstalled, options.previous);
    if (
      !previousInstalled.compatiblePackageVersions.includes(options.current.package.version)
      || !options.current.contracts.every((version) =>
        previousInstalled?.compatibleContractVersions.includes(version))
    ) {
      throw new Error("ROLLBACK_SCHEMA_INCOMPATIBLE");
    }
    currentInstallAttempted = true;
    const installed = await options.lifecycle.installExact(exactNpmRelease(options.current));
    assertInstalled(installed, options.current);
    scenarios.push(pass("install"));

    activeScenario = "upgrade-compatibility";
    if (!installed.compatiblePackageVersions.includes(options.previous.package.version)) {
      throw new Error("PREVIOUS_PACKAGE_INCOMPATIBLE");
    }
    if (!options.previous.contracts.every((version) =>
      installed.compatibleContractVersions.includes(version))) {
      throw new Error("PREVIOUS_CONTRACTS_INCOMPATIBLE");
    }
    scenarios.push(pass(activeScenario));

    for (const mode of DEPLOYMENT_MODES) {
      activeScenario = mode;
      await options.lifecycle.setMode(mode);
      assertProbe(mode, await options.lifecycle.probe());
      scenarios.push(pass(mode));
    }

    activeScenario = "restart-continuity";
    const beforeRestart = await options.lifecycle.inspect();
    await options.lifecycle.restart();
    const afterRestart = await options.lifecycle.inspect();
    assertInstalled(afterRestart, options.current);
    if (!sameContinuity(beforeRestart, afterRestart)) {
      throw new Error("RESTART_CONTINUITY_MISMATCH");
    }
    scenarios.push(pass(activeScenario));
  } catch (error: unknown) {
    failed = true;
    scenarios.push(fail(activeScenario, reasonCodeFor(activeScenario, error)));
  }

  if (!currentInstallAttempted) {
    return {
      schema_version: "cognitive-runtime.conformance-receipt/v2",
      status: "fail",
      package: {
        name: options.current.package.name,
        version: options.current.package.version,
        integrity: options.current.package.integrity,
      },
      openclaw_version: options.current.openclaw.version,
      scenarios: scenarios as ConsumerConformanceReceipt["scenarios"],
      provenance: {
        tarball_sha512: options.current.package.integrity,
        reproduced_tarball_sha512: options.provenance.reproduced_tarball_sha512,
        release_pin_sha256: releasePinChecksum(options.current),
        source_revision: options.provenance.source_revision,
        lockfile_sha256: options.provenance.lockfile_sha256,
        build_commands: [...options.provenance.build_commands],
      },
    };
  }
  try {
    const rolledBack = await options.lifecycle.rollbackExact(exactNpmRelease(options.previous));
    assertInstalled(rolledBack, options.previous);
    if (previousInstalled === null || !sameContinuity(previousInstalled, rolledBack)) {
      throw new Error("ROLLBACK_CONTINUITY_MISMATCH");
    }
    scenarios.push(pass("rollback"));
  } catch (error: unknown) {
    failed = true;
    scenarios.push(fail("rollback", reasonCodeFor("rollback", error)));
  }

  return {
    schema_version: "cognitive-runtime.conformance-receipt/v2",
    status: failed ? "fail" : "pass",
    package: {
      name: options.current.package.name,
      version: options.current.package.version,
      integrity: options.current.package.integrity,
    },
    openclaw_version: options.current.openclaw.version,
    scenarios: scenarios as ConsumerConformanceReceipt["scenarios"],
    provenance: {
      tarball_sha512: options.current.package.integrity,
      reproduced_tarball_sha512: options.provenance.reproduced_tarball_sha512,
      release_pin_sha256: releasePinChecksum(options.current),
      source_revision: options.provenance.source_revision,
      lockfile_sha256: options.provenance.lockfile_sha256,
      build_commands: [...options.provenance.build_commands],
    },
  };
}

interface RecoverySourcePort<TSnapshot, TBackupOptions, TVerifyOptions, TReport> {
  backup(options: TBackupOptions): Promise<TSnapshot>;
  verify(snapshot: TSnapshot, options: TVerifyOptions): Promise<TReport>;
}

interface RecoveryTargetPort<TSnapshot, TRestoreOptions, TReport> {
  restore(snapshot: TSnapshot, options: TRestoreOptions): Promise<TReport>;
}

export async function rehearseRecoveryTransport<
  TSnapshot,
  TBackupOptions,
  TVerifyOptions,
  TRestoreOptions,
  TVerifyReport,
  TRestoreReport,
>(options: {
  readonly source: RecoverySourcePort<TSnapshot, TBackupOptions, TVerifyOptions, TVerifyReport>;
  readonly target: RecoveryTargetPort<TSnapshot, TRestoreOptions, TRestoreReport>;
  readonly backupOptions: TBackupOptions;
  readonly verifyOptions: TVerifyOptions;
  readonly restoreOptions: TRestoreOptions;
}): Promise<{
  readonly verification: TVerifyReport;
  readonly restore: TRestoreReport;
}> {
  let snapshot: TSnapshot;
  try {
    snapshot = await options.source.backup(options.backupOptions);
  } catch {
    throw new Error("RECOVERY_BACKUP_FAILED");
  }
  let verification: TVerifyReport;
  try {
    verification = await options.source.verify(snapshot, options.verifyOptions);
  } catch {
    throw new Error("RECOVERY_VERIFY_FAILED");
  }
  let restore: TRestoreReport;
  try {
    restore = await options.target.restore(snapshot, options.restoreOptions);
  } catch {
    throw new Error("RECOVERY_RESTORE_FAILED");
  }
  return { verification, restore };
}
