export { runSelfCheck } from "./cli/index.js";
export type { SelfCheckResult } from "./cli/index.js";
export {
  lintAuthorityRecord,
  parseAuthorityMarkdown,
  resolveStableId,
} from "./authority/index.js";
export type {
  AuthorityLayer,
  AuthorityLintIssue,
  AuthorityLintResult,
  AuthorityRecord,
} from "./authority/index.js";
export { validateContract } from "./contracts/index.js";
export type {
  CognitiveBinding,
  CognitiveEntity,
  CognitiveProvenanceOverlay,
  ContractName,
  ContractValidationError,
  ContractValidationResult,
  CurrentStateEvent,
  CurrentStateHead,
  EvidenceSource,
  PersonalModel,
  ReanswerOutbox,
  RouterResult,
  RuntimeRecoverySnapshotManifest,
  RuntimeRecoveryVerificationOrRestoreReport,
  SemanticClaim,
} from "./contracts/index.js";
export { RunScratchMap } from "./core/index.js";
export type {
  RunBinding,
  RunObservation,
  RunScratchLifecycle,
  RunScratchMapOptions,
  RunScratchPort,
  RunScratchSnapshot,
} from "./core/index.js";
export { MemoryObservationAdapter } from "./openclaw/ports.js";
export type {
  HostCapabilityManifest,
  MemoryObservation,
  MemoryObservationPort,
  MemoryToolResult,
} from "./openclaw/ports.js";
export { CompareAndSetRemediation } from "./packet/index.js";
export type {
  CompareAndSetRemediationOptions,
  RemediationCasResult,
  RemediationOutcome,
  RemediationPort,
  RemediationRequest,
} from "./packet/index.js";
export {
  AUTHORITATIVE_SNAPSHOT_CONTENTS,
  createRuntimeRecoveryPort,
  EXCLUDED_SNAPSHOT_CONTENTS,
  openRuntimeRecoverySnapshot,
} from "./recovery/index.js";
export type {
  RuntimeBackupOptions,
  RuntimeRecoveryPort,
  RuntimeRecoverySnapshot,
  RuntimeRecoveryStorageOptions,
  RuntimeRestoreOptions,
  RuntimeVerifyOptions,
} from "./recovery/index.js";
export { calculateRegistryChecksum, StrictRouter } from "./router/index.js";
export type {
  RegistryRole,
  RouterDegradedReason,
  RouterOutcome,
  RouterPort,
  RouterRegistry,
  RouterRegistryEntry,
  RouterRequest,
  StrictRouterOptions,
} from "./router/index.js";
export type {
  CorrectionInput,
  ReanswerAttempt,
  ReanswerClaim,
  ReanswerDeliveryMode,
  ReanswerPort,
} from "./state/index.js";
