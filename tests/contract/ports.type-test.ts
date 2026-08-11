import type {
  MemoryObservationPort,
  ReanswerPort,
  RemediationPort,
  RouterPort,
  RunScratchPort,
  RuntimeRecoveryPort,
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
