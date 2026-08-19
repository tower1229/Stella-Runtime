export { runSelfCheck } from "./cli/index.js";
export type { SelfCheckResult } from "./cli/index.js";
export {
  DRIFT_REASON_CODES,
  inspectGenerationStatus,
  inspectStoredGenerationStatus,
  loadActiveGenerationHealth,
  readLatestAuthorityRevision,
  RUNTIME_HEALTH_FILE,
  RuntimeHealthMonitor,
  validateActiveReceipt,
} from "./diagnostics/index.js";
export type {
  ActiveGenerationHealthSnapshot,
  DriftReasonCode,
  GenerationOperationalStatus,
  LifecycleTrace,
  LifecycleOutcome,
  ReceiptValidity,
  ReconciliationReceipt,
  ReconciliationTrigger,
  RuntimeHealthMetrics,
  RuntimeHealthOptions,
  RuntimeSelfCheckResult,
} from "./diagnostics/index.js";
export {
  admitFramework,
  calculateCandidateContentChecksum,
  calculateCandidateExactDiff,
  calculateCognitiveAuthorityChecksum,
  CandidateAdmissionService,
  CONFIRMATION_ACTIONS,
} from "./admission/index.js";
export type {
  ApprovalReceiptConsumptionInput,
  BindConfirmationMessageInput,
  CandidateAdmissionServiceOptions,
  CandidateAdmissionPersistencePort,
  CandidateAuthorityHead,
  CandidateAuthorityHeadPort,
  CandidateRewriteInput,
  CandidateRevisionInput,
  CandidateType,
  ConfirmationAction,
  ConfirmationDecision,
  ConfirmationDecisionInput,
  ConfirmationPreparation,
  ConfirmationPreparationInput,
  DiscoveryAuthorizationInput,
  FrameworkAdmissionDecision,
  FrameworkAdmissionProposal,
  FrameworkAdmissionResult,
} from "./admission/index.js";
export { FileCandidateAdmissionStore } from "./admission/persistence.js";
export type {
  ApprovedCandidateRevision,
  FileCandidateAdmissionStoreOptions,
} from "./admission/persistence.js";
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
  DiscoveryAuthorization,
  AuthorityCandidate,
  CandidateReviewArtifact,
  ApprovalMessageReference,
  DecisionReceipt,
  ChangeSet,
  StateView,
  StateImportManifest,
  StateCorrectionPreview,
  StateCorrectionReceipt,
  GenerationManifest,
  ProjectionEntry,
  ActiveGenerationPointer,
  ActivationReceipt,
  InstanceRuntimeConfig,
  InstanceCutoverPlan,
  SemanticClaim,
  ReleasePin,
  ConsumerConformanceReceipt,
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
export {
  calculateInstanceCutoverPlanChecksum,
  validateInstanceCutoverPlan,
} from "./cutover/index.js";
export type {
  CutoverAcceptanceAfterInput,
  CutoverAcceptanceBeforeInput,
  CutoverAcceptanceEvidence,
  CutoverExecutionOptions,
  CutoverPublicationInput,
  CutoverPublicationPrerequisitePort,
  CutoverTarget,
  CutoverTargetIdentity,
  InstanceCutoverPlanPayload,
  PublicCorpusAdapterPort,
  PublicCorpusVerificationEvidence,
} from "./cutover/index.js";
export {
  calculatePublicationContentChecksum,
  ChangeSetPublicationCoordinator,
  createChangeSet,
  FileApprovalPublicationStore,
  FilePublicationJournal,
} from "./publication/index.js";
export type {
  ApprovalPublicationFinalization,
  ApprovalPublicationPort,
  AuthorityCheckoutInspection,
  AuthorityCommitMetadata,
  AuthorityPublicationCommit,
  AuthorityPublicationValidation,
  AuthorityPublishingPort,
  ChangeSetPublicationCoordinatorOptions,
  ChangeSetArtifact,
  FilePublicationJournalOptions,
  FileApprovalPublicationStoreOptions,
  PublicationFailpoint,
  PublicationJournalRecord,
  PublicationJournalPort,
  PublicationOperation,
  PublicationResult,
  PreparedApprovalPublication,
} from "./publication/index.js";
export {
  calculateReleasePinChecksum,
  createReleaseProvenance,
  rehearseRecoveryTransport,
  runReleaseConformance,
} from "./conformance/index.js";
export type {
  ExactNpmRelease,
  ReleaseConformanceOptions,
  ReleaseInspection,
  ReleaseLifecyclePort,
} from "./conformance/index.js";
export {
  buildGeneration,
  loadActiveGeneration,
  showGeneration,
  validateAuthoritySource,
  verifyGeneration,
} from "./generation/index.js";
export type {
  ActiveGeneration,
  AuthorityValidationOptions,
  AuthorityValidationResult,
  BootstrapProjectionResult,
  BootstrapTarget,
  GenerationArtifact,
  GenerationBuildOptions,
  GenerationBuildResult,
  GenerationManifestFile,
  GenerationStatus,
  GenerationVerificationResult,
} from "./generation/index.js";
export { MemoryObservationAdapter } from "./openclaw/ports.js";
export {
  OpenClawCliRetrievalCommands,
  OpenClawGenerationConsumptionAdapter,
  RETRIEVAL_PATH_OWNERSHIP_FILE,
} from "./openclaw/consumption.js";
export type {
  OpenClawCommandRunner,
  OpenClawConsumptionApi,
  OpenClawInstanceCutoverPort,
  OpenClawRetrievalCommands,
} from "./openclaw/consumption.js";
export type {
  HostCapabilityManifest,
  MemoryObservation,
  MemoryObservationPort,
  MemoryToolResult,
} from "./openclaw/ports.js";
export {
  buildTelegramConfirmationActions,
  configureOpenClawCandidateAdmissionPersistence,
  configureOpenClawCandidateAuthorityHead,
  createOpenClawTelegramConfirmationPresentation,
  OPENCLAW_TELEGRAM_CONFIRMATION_VERSION,
  openClawCandidateAdmissionService,
  presentTelegramConfirmation,
  registerTelegramConfirmationGateway,
  TELEGRAM_CONFIRMATION_NAMESPACE,
} from "./openclaw/confirmation.js";
export type {
  OpenClawTelegramPresentationRuntime,
  TelegramConfirmationAction,
  TelegramConfirmationGatewayOptions,
  TelegramConfirmationPluginApi,
  TelegramConfirmationPresentationPort,
  PresentedTelegramConfirmation,
} from "./openclaw/confirmation.js";
export {
  buildExplicitContextPacket,
  CompareAndSetRemediation,
} from "./packet/index.js";
export type {
  CompareAndSetRemediationOptions,
  ExplicitContextBinding,
  ExplicitContextEntry,
  ExplicitContextPacketOptions,
  RemediationCasResult,
  RemediationOutcome,
  RemediationPort,
  RemediationRequest,
  VersionedExplicitContextEntry,
} from "./packet/index.js";
export type {
  ProvenancePort,
  ProvenanceQuery,
} from "./provenance/index.js";
export {
  AUTHORITATIVE_RUNTIME_STATE_CONTENTS,
  createRuntimeVerifyOptions,
  createRuntimeRecoveryPort,
  RUNTIME_RECOVERY_SNAPSHOT_EXCLUDED_CONTENTS,
  openRuntimeRecoverySnapshot,
  recoverInterruptedRuntimeRestore,
  RUNTIME_RECOVERY_COMPATIBILITY,
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
export {
  ACTIVATION_RECEIPTS_DIRECTORY,
  ACTIVE_GENERATION_POINTER_FILE,
  calculateRuntimeConfigIdentityChecksum,
  FileBindingCompiler,
} from "./runtime/binding.js";
export type {
  ActiveRunBinding,
  BindingCompilerInput,
  BindingCompilerPort,
} from "./runtime/binding.js";
export {
  loadMaintenanceGate,
  MAINTENANCE_GATE_FILE,
  recoverInterruptedSync,
  syncGeneration,
  SYNC_JOURNAL_FILE,
} from "./sync/index.js";
export type {
  EligibleRunDrainPort,
  HostIndexEvidence,
  HostSnapshot,
  HostTransitionPort,
  MaintenanceGate,
  SyncGenerationOptions,
  SyncGenerationResult,
  SyncRecoveryOptions,
  SyncTarget,
} from "./sync/index.js";
export type {
  CorrectionInput,
  ReanswerAttempt,
  ReanswerClaim,
  ReanswerDeliveryMode,
  ReanswerPort,
  SessionReanswerPort,
  StatePort,
  StateViewEntry,
  StateViewRequest,
} from "./state/index.js";
export {
  calculateCurrentStateEventChecksum,
  calculateStateImportManifestChecksum,
  createExactStateImportPolicy,
  createStateManagementPort,
  prepareStateImportManifest,
} from "./state/management.js";
export type {
  ExactStateImportAuthorization,
  StateCorrectionApplyInput,
  StateCorrectionPlanInput,
  StateCorrectionResult,
  StateImportResult,
  StateImportSourcePolicy,
  StateInitializationResult,
  StateManagementOptions,
  StateManagementPort,
} from "./state/management.js";
