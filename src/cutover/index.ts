import type { InstanceCutoverPlan } from "../contracts/index.js";
import { validateContract } from "../contracts/index.js";
import { checksumCanonicalJson } from "../core/canonical-json.js";
import type { BootstrapProjectionResult } from "../generation/index.js";

export type InstanceCutoverPlanPayload = Omit<InstanceCutoverPlan, "checksum">;

export interface CutoverPublicationInput {
  readonly plan: InstanceCutoverPlan;
  readonly sourceRevision: string;
}

export interface CutoverPublicationPrerequisitePort {
  verifyRemoteBase(input: CutoverPublicationInput): Promise<void>;
  verifyPushedRevision(input: CutoverPublicationInput): Promise<void>;
}

export interface CutoverTargetIdentity {
  readonly sourceRevision: string;
  readonly syncGeneration: string;
}

export interface CutoverAcceptanceBeforeInput {
  readonly plan: InstanceCutoverPlan;
}

export interface PublicCorpusVerificationEvidence {
  readonly adapterId: string;
  readonly health: "pass";
  readonly recallChecksum: string;
}

export interface CutoverAcceptanceEvidence {
  readonly publicCorpus: PublicCorpusVerificationEvidence;
  readonly legacyPrivateHits: 0;
  readonly privateRetrievalGenerations: readonly string[];
}

export interface CutoverAcceptanceAfterInput {
  readonly plan: InstanceCutoverPlan;
  readonly target: CutoverTargetIdentity;
}

export interface PublicCorpusAdapterPort {
  verifyBefore(
    input: CutoverAcceptanceBeforeInput,
  ): Promise<PublicCorpusVerificationEvidence>;
  indexTarget(input: CutoverAcceptanceAfterInput): Promise<void>;
  verifyAfter(input: CutoverAcceptanceAfterInput): Promise<CutoverAcceptanceEvidence>;
}

export interface CutoverExecutionOptions {
  readonly plan: InstanceCutoverPlan;
  readonly publication?: CutoverPublicationPrerequisitePort;
  readonly publicCorpus?: PublicCorpusAdapterPort;
}

export interface CutoverTarget {
  readonly plan: InstanceCutoverPlan;
  readonly bootstrapProjections: readonly BootstrapProjectionResult[];
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const calculateInstanceCutoverPlanChecksum = (
  plan: InstanceCutoverPlanPayload,
): string => checksumCanonicalJson(plan, {
  invalidValueReason: "CUTOVER_PLAN_VALUE_INVALID",
});

const planPayload = (plan: InstanceCutoverPlan): InstanceCutoverPlanPayload => {
  const { checksum: _checksum, ...payload } = plan;
  return payload;
};

const checksumPattern = /^sha256:[a-f0-9]{64}$/;

const validatePublicCorpusEvidence = (
  evidence: unknown,
  plan: InstanceCutoverPlan,
): void => {
  if (
    !isRecord(evidence) ||
    evidence.adapterId !== plan.public_corpus_adapter ||
    evidence.health !== "pass" ||
    typeof evidence.recallChecksum !== "string" ||
    !checksumPattern.test(evidence.recallChecksum)
  ) {
    throw new Error("CUTOVER_PUBLIC_CORPUS_EVIDENCE_INVALID");
  }
};

export const validateInstanceCutoverPlan = (
  plan: InstanceCutoverPlan,
  instanceId: string,
  sourceRevision: string,
): void => {
  if (!validateContract("instance-cutover-plan", plan).valid) {
    throw new Error("CUTOVER_PLAN_INVALID");
  }
  if (plan.checksum !== calculateInstanceCutoverPlanChecksum(planPayload(plan))) {
    throw new Error("CUTOVER_PLAN_CHECKSUM_MISMATCH");
  }
  if (plan.instance_id !== instanceId) {
    throw new Error("CUTOVER_PLAN_INSTANCE_MISMATCH");
  }
  if (plan.target_source_revision !== sourceRevision) {
    throw new Error("CUTOVER_PLAN_SOURCE_REVISION_MISMATCH");
  }
};

export const verifyCutoverPrerequisites = async (
  options: CutoverExecutionOptions,
  sourceRevision: string,
): Promise<void> => {
  const { plan, publication, publicCorpus } = options;
  const requiresPublication = plan.publication_prerequisites.remote_base_check ||
    plan.publication_prerequisites.push_before_sync;
  if (requiresPublication && publication === undefined) {
    throw new Error("CUTOVER_PUBLICATION_PORT_REQUIRED");
  }
  if (plan.publication_prerequisites.remote_base_check) {
    await publication?.verifyRemoteBase({ plan, sourceRevision });
  }
  if (plan.publication_prerequisites.push_before_sync) {
    await publication?.verifyPushedRevision({ plan, sourceRevision });
  }
  if (plan.public_corpus_adapter !== undefined) {
    if (publicCorpus === undefined) throw new Error("CUTOVER_PUBLIC_CORPUS_PORT_REQUIRED");
    validatePublicCorpusEvidence(await publicCorpus.verifyBefore({ plan }), plan);
  }
};

export const indexCutoverPublicCorpus = async (
  options: CutoverExecutionOptions,
  target: CutoverTargetIdentity,
): Promise<void> => {
  if (options.plan.public_corpus_adapter !== undefined) {
    if (options.publicCorpus === undefined) {
      throw new Error("CUTOVER_PUBLIC_CORPUS_PORT_REQUIRED");
    }
    await options.publicCorpus.indexTarget({ plan: options.plan, target });
  }
};

export const verifyCutoverAcceptance = async (
  options: CutoverExecutionOptions,
  target: CutoverTargetIdentity,
): Promise<void> => {
  if (options.plan.public_corpus_adapter !== undefined) {
    if (options.publicCorpus === undefined) {
      throw new Error("CUTOVER_PUBLIC_CORPUS_PORT_REQUIRED");
    }
    const evidence = await options.publicCorpus.verifyAfter({
      plan: options.plan,
      target,
    });
    if (!isRecord(evidence)) {
      throw new Error("CUTOVER_ACCEPTANCE_EVIDENCE_INVALID");
    }
    validatePublicCorpusEvidence(evidence.publicCorpus, options.plan);
    if (evidence.legacyPrivateHits !== 0) {
      throw new Error("CUTOVER_LEGACY_PRIVATE_HITS_PRESENT");
    }
    const privateRetrievalGenerations = evidence.privateRetrievalGenerations;
    if (
      !Array.isArray(privateRetrievalGenerations) ||
      privateRetrievalGenerations.some((generation) => typeof generation !== "string") ||
      privateRetrievalGenerations.length !== 1 ||
      privateRetrievalGenerations[0] !== target.syncGeneration
    ) {
      throw new Error("CUTOVER_PRIVATE_RETRIEVAL_COEXISTENCE");
    }
  }
};
