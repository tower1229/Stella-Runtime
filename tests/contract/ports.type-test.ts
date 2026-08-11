import type {
  HostCapabilityManifest,
  MemoryObservationPort,
  ReanswerPort,
  RemediationPort,
  RouterPort,
  RunScratchPort,
  RuntimeRecoveryPort,
  RuntimeRestoreOptions,
  RuntimeVerifyOptions,
} from "../../src/index.js";

type AsyncMethod<T> = (...args: never[]) => Promise<T>;

declare const router: RouterPort<unknown, "routed">;
declare const scratch: RunScratchPort<unknown, unknown, unknown>;
declare const memory: MemoryObservationPort<unknown, "observed">;
declare const remediation: RemediationPort<unknown, "remediated">;
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
  access: "read_only",
};
verifyOptions satisfies RuntimeVerifyOptions;

const restoreOptions: RuntimeRestoreOptions = {
  targetInstanceId: "instance-synthetic",
  targetHasServedRun: false,
  restoreIdempotencyKey: "restore-synthetic-1",
  rollback: "required",
  supportedSnapshotSchemaVersions: ["cognitive-runtime.runtime-recovery-snapshot-manifest/v1"],
  supportedStorageSchemaVersions: ["1"],
};
restoreOptions satisfies RuntimeRestoreOptions;
