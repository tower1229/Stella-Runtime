import type {
  HostCapabilityManifest,
  MemoryObservationPort,
  ProvenancePort,
  ReanswerPort,
  RemediationPort,
  RouterPort,
  RunScratchPort,
  StatePort,
  RuntimeRecoveryPort,
  RuntimeRestoreOptions,
  RuntimeVerifyOptions,
} from "../../src/index.js";

type AsyncMethod<T> = (...args: never[]) => Promise<T>;

declare const router: RouterPort<unknown, "routed">;
declare const scratch: RunScratchPort<unknown, unknown, unknown>;
declare const memory: MemoryObservationPort<unknown, "observed">;
declare const remediation: RemediationPort<unknown, "remediated">;
declare const state: StatePort<unknown, "view", unknown, "receipt">;
declare const provenance: ProvenancePort<"overlay", unknown>;
declare const reanswer: ReanswerPort<unknown, unknown>;
declare const recovery: RuntimeRecoveryPort<
  unknown,
  unknown,
  unknown,
  "snapshot",
  "report"
>;

router.route satisfies AsyncMethod<"routed">;
scratch.acquire satisfies AsyncMethod<unknown>;
scratch.observe satisfies AsyncMethod<void>;
scratch.claimRemediation satisfies AsyncMethod<unknown>;
scratch.release satisfies AsyncMethod<void>;
memory.observe satisfies (...args: never[]) => "observed" | null;
remediation.remediate satisfies AsyncMethod<"remediated">;
state.view satisfies AsyncMethod<"view">;
state.correct satisfies AsyncMethod<"receipt">;
provenance.record satisfies AsyncMethod<"overlay">;
provenance.get satisfies AsyncMethod<"overlay" | null>;
provenance.query satisfies AsyncMethod<readonly "overlay"[]>;
reanswer.claim satisfies AsyncMethod<unknown | null>;
reanswer.complete satisfies AsyncMethod<void>;
reanswer.release satisfies AsyncMethod<void>;
recovery.backup satisfies AsyncMethod<"snapshot">;
recovery.verify satisfies AsyncMethod<"report">;
recovery.restore satisfies AsyncMethod<"report">;

const capabilities: HostCapabilityManifest = {
  runContextRoundTrip: false,
  embeddedWorkAdmission: false,
  hostNextTurnInjection: false,
  commandContinuationSuccessor: true,
  uiNormalRpcSuccessor: true,
};
capabilities satisfies HostCapabilityManifest;

const verifyOptions: RuntimeVerifyOptions = {
  expectedInstanceId: "instance-synthetic",
  supportedSnapshotSchemaVersions: ["cognitive-runtime.runtime-recovery-snapshot-manifest/v1"],
  supportedStorageSchemaVersions: ["1"],
  supportedPackageVersions: ["0.0.0"],
  supportedContractVersions: ["v1"],
  access: "read_only",
};
verifyOptions satisfies RuntimeVerifyOptions;

const restoreOptions: RuntimeRestoreOptions = {
  targetInstanceId: "instance-synthetic",
  restoreIdempotencyKey: "restore-synthetic-1",
  rollback: "required",
  supportedSnapshotSchemaVersions: ["cognitive-runtime.runtime-recovery-snapshot-manifest/v1"],
  supportedStorageSchemaVersions: ["1"],
  supportedPackageVersions: ["0.0.0"],
  supportedContractVersions: ["v1"],
};
restoreOptions satisfies RuntimeRestoreOptions;
