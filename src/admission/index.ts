import { randomBytes } from "node:crypto";

import {
  lintAuthorityRecord,
  parseAuthorityMarkdown,
  type AuthorityRecord,
} from "../authority/index.js";
import {
  type AuthorityCandidate,
  type ApprovalMessageReference,
  type CandidateReviewArtifact,
  type DecisionReceipt,
  type DiscoveryAuthorization,
  validateContract,
} from "../contracts/index.js";
import {
  canonicalJson,
  checksumCanonicalJson,
} from "../core/canonical-json.js";
import type {
  ApprovalPublicationFinalization,
  ChangeSetArtifact,
} from "../publication/index.js";

export type FrameworkAdmissionDecision = "accepted" | "rejected" | "rewritten";

export interface FrameworkAdmissionProposal {
  readonly sourceAuthor: {
    readonly sourceRefs: readonly string[];
    readonly claims: readonly string[];
  };
  readonly modelSynthesis: string;
  readonly userUnderstanding: {
    readonly decision: FrameworkAdmissionDecision;
    readonly statement: string;
    readonly confirmedAuthorityChecksum?: string;
  };
  readonly authorityMarkdown?: string;
}

export type FrameworkAdmissionResult =
  | {
      readonly status: "admitted";
      readonly decision: "accepted" | "rewritten";
      readonly confirmedUnderstanding: string;
      readonly record: AuthorityRecord;
    }
  | {
      readonly status: "rejected";
      readonly decision: "rejected";
    };

const requireNonEmpty = (value: string, reason: string): void => {
  if (value.trim().length === 0) {
    throw new Error(reason);
  }
};

export function calculateCognitiveAuthorityChecksum(markdown: string): string {
  const record = parseAuthorityMarkdown(markdown);
  return checksumCanonicalJson({
    id: record.id,
    schemaVersion: record.schemaVersion,
    recordType: record.recordType,
    frontmatter: record.frontmatter,
    body: record.body,
  });
}

const sameStrings = (
  left: readonly string[],
  right: readonly string[],
): boolean => {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index]);
};

export function admitFramework(
  proposal: FrameworkAdmissionProposal,
): FrameworkAdmissionResult {
  if (!["accepted", "rejected", "rewritten"].includes(
    proposal.userUnderstanding.decision,
  )) {
    throw new Error("ADMISSION_DECISION_INVALID");
  }
  if (
    proposal.sourceAuthor.claims.length === 0 ||
    proposal.sourceAuthor.claims.some((claim) => claim.trim().length === 0) ||
    proposal.sourceAuthor.sourceRefs.length === 0 ||
    proposal.sourceAuthor.sourceRefs.some((ref) => ref.trim().length === 0)
  ) {
    throw new Error("ADMISSION_SOURCE_AUTHOR_REQUIRED");
  }
  requireNonEmpty(proposal.modelSynthesis, "ADMISSION_MODEL_SYNTHESIS_REQUIRED");
  requireNonEmpty(
    proposal.userUnderstanding.statement,
    "ADMISSION_USER_UNDERSTANDING_REQUIRED",
  );
  if (proposal.userUnderstanding.decision === "rejected") {
    if (
      proposal.authorityMarkdown !== undefined ||
      proposal.userUnderstanding.confirmedAuthorityChecksum !== undefined
    ) {
      throw new Error("ADMISSION_REJECTED_AUTHORITY_FORBIDDEN");
    }
    return { status: "rejected", decision: "rejected" };
  }
  if (proposal.authorityMarkdown === undefined) {
    throw new Error("ADMISSION_AUTHORITY_MARKDOWN_REQUIRED");
  }
  if (
    proposal.userUnderstanding.confirmedAuthorityChecksum === undefined ||
    proposal.userUnderstanding.confirmedAuthorityChecksum !==
      calculateCognitiveAuthorityChecksum(proposal.authorityMarkdown)
  ) {
    throw new Error("ADMISSION_CONFIRMATION_MISMATCH");
  }
  const record = parseAuthorityMarkdown(proposal.authorityMarkdown);
  if (record.layer !== "cognitive") {
    throw new Error("ADMISSION_COGNITIVE_REQUIRED");
  }
  const lint = lintAuthorityRecord(record);
  if (!lint.valid) {
    throw new Error(
      `ADMISSION_COGNITIVE_INVALID:${lint.issues.map((issue) => issue.code).join(",")}`,
    );
  }
  const recordSourceRefs = record.frontmatter.source_refs;
  if (
    !Array.isArray(recordSourceRefs) ||
    recordSourceRefs.some((ref) => typeof ref !== "string") ||
    !sameStrings(recordSourceRefs as readonly string[], proposal.sourceAuthor.sourceRefs)
  ) {
    throw new Error("ADMISSION_SOURCE_REF_MISMATCH");
  }
  return {
    status: "admitted",
    decision: proposal.userUnderstanding.decision,
    confirmedUnderstanding: proposal.userUnderstanding.statement,
    record,
  };
}

export type CandidateType = "semantic" | "personal_model" | "cognitive";

export interface CandidateAuthorityHead {
  readonly version: string;
  readonly checksum: string;
}

export interface CandidateAuthorityHeadPort {
  getCurrent(input: {
    readonly instanceId: string;
    readonly candidateType: CandidateType;
    readonly stableId: string;
  }): CandidateAuthorityHead | null;
}

export interface CandidateAdmissionServiceOptions {
  readonly now?: () => Date;
  readonly createId?: (
    kind: "authorization" | "candidate" | "review" | "request" | "receipt",
  ) => string;
  readonly createRoutingToken?: () => string;
  readonly authorityHead?: CandidateAuthorityHeadPort;
  readonly lifecycle?: { recordLifecycle(outcome: "accepted"): void };
  readonly persistence?: CandidateAdmissionPersistencePort;
}

export interface CandidateAdmissionSnapshot {
  readonly schemaVersion: "stella-runtime.candidate-admission-store/v1";
  readonly authorizations: readonly DiscoveryAuthorization[];
  readonly candidates: readonly {
    readonly candidateId: string;
    readonly authorizationId: string;
    readonly revisions: readonly AuthorityCandidate[];
  }[];
  readonly candidateTargets: readonly {
    readonly targetKey: string;
    readonly candidateId: string;
  }[];
  readonly confirmations: readonly {
    readonly authorizationId: string;
    readonly requestId: string;
    readonly candidate: AuthorityCandidate;
    readonly reviewArtifact: CandidateReviewArtifact;
    readonly routingToken: string;
    readonly messageReference: ApprovalMessageReference | null;
  }[];
  readonly receipts: readonly {
    readonly authorizationId: string;
    readonly receipt: DecisionReceipt;
    readonly consumed: boolean;
    readonly invalidated: boolean;
    readonly artifact: ChangeSetArtifact | null;
    readonly finalization: ApprovalPublicationFinalization | null;
  }[];
}

export interface CandidateAdmissionPersistencePort {
  transact<T>(operation: (snapshot: unknown) => {
    readonly snapshot: unknown;
    readonly result: T;
  }): T;
}

export interface DiscoveryAuthorizationInput {
  readonly instanceId: string;
  readonly scope: {
    readonly candidateTypes: readonly CandidateType[];
    readonly sourceRefs: readonly string[];
  };
  readonly grantedBy: string;
  readonly expiresAt: string;
}

export interface CandidateRevisionInput {
  readonly authorizationId: string;
  readonly candidateType: CandidateType;
  readonly stableId: string;
  readonly baseAuthorityVersion: string | null;
  readonly baseChecksum: string | null;
  readonly baseContent: Readonly<Record<string, unknown>> | null;
  readonly content: Readonly<Record<string, unknown>>;
  readonly sourceMap: readonly {
    readonly sourceRef: string;
    readonly contentPath: string;
  }[];
}

export interface CandidateRewriteInput {
  readonly authorizationId: string;
  readonly candidateId: string;
  readonly baseAuthorityVersion: string | null;
  readonly baseChecksum: string | null;
  readonly baseContent: Readonly<Record<string, unknown>> | null;
  readonly content: Readonly<Record<string, unknown>>;
  readonly sourceMap: CandidateRevisionInput["sourceMap"];
}

export interface ConfirmationPreparationInput {
  readonly authorizationId: string;
  readonly candidateId: string;
  readonly revision: number;
  readonly channel: string;
}

export type ConfirmationPreparation =
  | {
      readonly status: "redirect_required";
      readonly confirmedChannel: "telegram";
    }
  | {
      readonly status: "ready";
      readonly requestId: string;
      readonly routingToken: string;
      readonly reviewArtifact: CandidateReviewArtifact;
    };

export const CONFIRMATION_ACTIONS = [
  "accept",
  "reject",
  "request-rewrite",
] as const;
export type ConfirmationAction = (typeof CONFIRMATION_ACTIONS)[number];

export interface BindConfirmationMessageInput {
  readonly routingToken: string;
  readonly messageReference: ApprovalMessageReference;
}

export interface ConfirmationDecisionInput {
  readonly routingToken: string;
  readonly action: string;
  readonly authorized: boolean;
  readonly senderId: string;
  readonly messageReference: ApprovalMessageReference;
}

export type ConfirmationDecision =
  | {
      readonly status: "rewrite_requested";
      readonly candidateId: string;
      readonly candidateRevision: number;
    }
  | {
      readonly status: "decided";
      readonly receipt: DecisionReceipt;
    };

export interface ApprovalReceiptConsumptionInput {
  readonly receiptId: string;
  readonly candidateId: string;
  readonly candidateRevision: number;
  readonly candidateChecksum: string;
  readonly baseAuthorityVersion: string | null;
}

interface ConfirmationRecord {
  readonly authorizationId: string;
  readonly requestId: string;
  readonly candidate: AuthorityCandidate;
  readonly reviewArtifact: CandidateReviewArtifact;
  readonly routingToken: string;
  messageReference: ApprovalMessageReference | null;
}

interface ReceiptRecord {
  readonly authorizationId: string;
  readonly receipt: DecisionReceipt;
  consumed: boolean;
  invalidated: boolean;
  artifact: ChangeSetArtifact | null;
  finalization: ApprovalPublicationFinalization | null;
}

const defaultId = (
  kind: "authorization" | "candidate" | "review" | "request" | "receipt",
): string => `${kind}-${randomBytes(16).toString("hex")}`;

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
};

const immutableCopy = <T>(value: T): T => deepFreeze(structuredClone(value));

const checksum = checksumCanonicalJson;

export const calculateCandidateContentChecksum = (
  content: Readonly<Record<string, unknown>>,
): string => checksum(content);

export const calculateCandidateExactDiff = (
  baseContent: Readonly<Record<string, unknown>> | null,
  content: Readonly<Record<string, unknown>>,
): string => [
  `base:${baseContent === null ? "null" : canonicalJson(baseContent)}`,
  `candidate:${canonicalJson(content)}`,
].join("\n");

const assertCandidateBase = (
  baseAuthorityVersion: string | null,
  baseChecksum: string | null,
  baseContent: Readonly<Record<string, unknown>> | null,
): void => {
  if (
    (baseAuthorityVersion === null) !== (baseChecksum === null) ||
    (baseAuthorityVersion === null) !== (baseContent === null)
  ) {
    throw new Error("CANDIDATE_BASE_INCOMPLETE");
  }
  if (
    baseContent !== null &&
    baseChecksum !== calculateCandidateContentChecksum(baseContent)
  ) {
    throw new Error("CANDIDATE_BASE_CHECKSUM_MISMATCH");
  }
};

const assertContract = (
  name:
    | "discovery-authorization"
    | "authority-candidate"
    | "candidate-review-artifact"
    | "approval-message-reference"
    | "decision-receipt",
  value: unknown,
): void => {
  const result = validateContract(name, value);
  if (!result.valid) {
    throw new Error(`ADMISSION_CONTRACT_INVALID:${name}`);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const emptyCandidateAdmissionSnapshot = (): CandidateAdmissionSnapshot => ({
  schemaVersion: "stella-runtime.candidate-admission-store/v1",
  authorizations: [],
  candidates: [],
  candidateTargets: [],
  confirmations: [],
  receipts: [],
});

export function parseCandidateAdmissionSnapshot(
  value: unknown,
): CandidateAdmissionSnapshot {
  if (value === null) return emptyCandidateAdmissionSnapshot();
  if (
    !isRecord(value) ||
    value.schemaVersion !== "stella-runtime.candidate-admission-store/v1" ||
    !Array.isArray(value.authorizations) ||
    !Array.isArray(value.candidates) ||
    !Array.isArray(value.candidateTargets) ||
    !Array.isArray(value.confirmations) ||
    !Array.isArray(value.receipts)
  ) {
    throw new Error("CANDIDATE_ADMISSION_STORE_INVALID");
  }
  for (const authorization of value.authorizations) {
    assertContract("discovery-authorization", authorization);
  }
  for (const record of value.candidates) {
    if (
      !isRecord(record) ||
      typeof record.candidateId !== "string" ||
      typeof record.authorizationId !== "string" ||
      !Array.isArray(record.revisions) ||
      record.revisions.length === 0
    ) throw new Error("CANDIDATE_ADMISSION_STORE_INVALID");
    for (const candidate of record.revisions) {
      assertContract("authority-candidate", candidate);
      if (!isRecord(candidate) || candidate.candidate_id !== record.candidateId) {
        throw new Error("CANDIDATE_ADMISSION_STORE_INVALID");
      }
    }
  }
  for (const target of value.candidateTargets) {
    if (
      !isRecord(target) ||
      typeof target.targetKey !== "string" ||
      typeof target.candidateId !== "string"
    ) throw new Error("CANDIDATE_ADMISSION_STORE_INVALID");
  }
  for (const confirmation of value.confirmations) {
    if (
      !isRecord(confirmation) ||
      typeof confirmation.authorizationId !== "string" ||
      typeof confirmation.requestId !== "string" ||
      typeof confirmation.routingToken !== "string" ||
      !(confirmation.messageReference === null || isRecord(confirmation.messageReference))
    ) throw new Error("CANDIDATE_ADMISSION_STORE_INVALID");
    assertContract("authority-candidate", confirmation.candidate);
    assertContract("candidate-review-artifact", confirmation.reviewArtifact);
    if (confirmation.messageReference !== null) {
      assertContract("approval-message-reference", confirmation.messageReference);
    }
  }
  for (const receipt of value.receipts) {
    if (
      !isRecord(receipt) ||
      typeof receipt.authorizationId !== "string" ||
      typeof receipt.consumed !== "boolean" ||
      typeof receipt.invalidated !== "boolean" ||
      !(receipt.artifact === null || isRecord(receipt.artifact)) ||
      !(receipt.finalization === null || isRecord(receipt.finalization))
    ) throw new Error("CANDIDATE_ADMISSION_STORE_INVALID");
    assertContract("decision-receipt", receipt.receipt);
  }
  return immutableCopy(value as unknown as CandidateAdmissionSnapshot);
}

const normalizeCandidateSourceMap = (
  authorization: DiscoveryAuthorization,
  sourceMap: CandidateRevisionInput["sourceMap"],
): AuthorityCandidate["source_map"] => {
  if (sourceMap.some((entry) =>
    !authorization.scope.source_refs.includes(entry.sourceRef))) {
    throw new Error("DISCOVERY_SOURCE_REF_OUT_OF_SCOPE");
  }
  const [first, ...rest] = sourceMap;
  if (first === undefined) {
    throw new Error("CANDIDATE_SOURCE_MAP_EMPTY");
  }
  return [first, ...rest].map((entry) => ({
    source_ref: entry.sourceRef,
    content_path: entry.contentPath,
  })) as AuthorityCandidate["source_map"];
};

const createCandidateRevision = (input: {
  readonly candidateId: string;
  readonly revision: number;
  readonly candidateType: CandidateType;
  readonly stableId: string;
  readonly baseAuthorityVersion: string | null;
  readonly baseChecksum: string | null;
  readonly baseContent: Readonly<Record<string, unknown>> | null;
  readonly content: Readonly<Record<string, unknown>>;
  readonly sourceMap: AuthorityCandidate["source_map"];
  readonly createdAt: string;
}): AuthorityCandidate => {
  const payload = {
    schema_version: "cognitive-runtime.authority-candidate/v2" as const,
    candidate_id: input.candidateId,
    revision: input.revision,
    candidate_type: input.candidateType,
    stable_id: input.stableId,
    base_authority_version: input.baseAuthorityVersion,
    base_checksum: input.baseChecksum,
    content: structuredClone(input.content),
    source_map: input.sourceMap,
    exact_diff: calculateCandidateExactDiff(input.baseContent, input.content),
    created_at: input.createdAt,
  };
  const candidate = {
    ...payload,
    checksum: checksum(payload),
  } satisfies AuthorityCandidate;
  assertContract("authority-candidate", candidate);
  return immutableCopy(candidate);
};

const isConfirmationAction = (value: string): value is ConfirmationAction =>
  CONFIRMATION_ACTIONS.some((action) => action === value);

const sameMessageReference = (
  left: ApprovalMessageReference,
  right: ApprovalMessageReference,
): boolean =>
  left.provider === right.provider &&
  left.instance_id === right.instance_id &&
  left.account_id === right.account_id &&
  left.conversation_id === right.conversation_id &&
  left.message_id === right.message_id;

export class CandidateAdmissionService {
  readonly #now: () => Date;
  readonly #createId: NonNullable<CandidateAdmissionServiceOptions["createId"]>;
  readonly #createRoutingToken: () => string;
  readonly #authorityHead: CandidateAuthorityHeadPort;
  readonly #lifecycle: CandidateAdmissionServiceOptions["lifecycle"];
  #persistence: CandidateAdmissionPersistencePort | undefined;
  #persistentTransactionActive = false;
  readonly #instanceLifecycles = new Map<
    string,
    NonNullable<CandidateAdmissionServiceOptions["lifecycle"]>
  >();
  readonly #authorizations = new Map<string, DiscoveryAuthorization>();
  readonly #candidates = new Map<string, readonly AuthorityCandidate[]>();
  readonly #candidateAuthorizations = new Map<string, string>();
  readonly #candidateIdsByTarget = new Map<string, string>();
  readonly #confirmationsByToken = new Map<string, ConfirmationRecord>();
  readonly #receipts = new Map<string, ReceiptRecord>();

  constructor(options: CandidateAdmissionServiceOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? defaultId;
    this.#createRoutingToken = options.createRoutingToken ??
      (() => randomBytes(32).toString("base64url"));
    this.#authorityHead = options.authorityHead ?? {
      getCurrent: () => {
        throw new Error("CANDIDATE_AUTHORITY_HEAD_UNAVAILABLE");
      },
    };
    this.#lifecycle = options.lifecycle;
    this.#persistence = options.persistence;
  }

  configurePersistence(persistence: CandidateAdmissionPersistencePort): void {
    if (this.#persistentTransactionActive) {
      throw new Error("CANDIDATE_ADMISSION_STORE_BUSY");
    }
    this.#persistence = persistence;
  }

  setInstanceLifecycleObserver(
    instanceId: string,
    lifecycle: NonNullable<CandidateAdmissionServiceOptions["lifecycle"]>,
  ): () => void {
    this.#instanceLifecycles.set(instanceId, lifecycle);
    return () => {
      if (this.#instanceLifecycles.get(instanceId) === lifecycle) {
        this.#instanceLifecycles.delete(instanceId);
      }
    };
  }

  authorizeDiscovery(input: DiscoveryAuthorizationInput): DiscoveryAuthorization {
    if (!this.#persistentTransactionActive && this.#persistence !== undefined) {
      return this.#withPersistentState(() => this.authorizeDiscovery(input));
    }
    const grantedAt = this.#now().toISOString();
    if (Date.parse(input.expiresAt) <= Date.parse(grantedAt)) {
      throw new Error("DISCOVERY_AUTHORIZATION_NOT_FINITE");
    }
    const [candidateType, ...candidateTypes] = input.scope.candidateTypes;
    const [sourceRef, ...sourceRefs] = input.scope.sourceRefs;
    if (candidateType === undefined || sourceRef === undefined) {
      throw new Error("DISCOVERY_SCOPE_EMPTY");
    }
    const authorization = {
      schema_version: "cognitive-runtime.discovery-authorization/v2",
      authorization_id: this.#createId("authorization"),
      instance_id: input.instanceId,
      scope: {
        candidate_types: [candidateType, ...candidateTypes],
        source_refs: [sourceRef, ...sourceRefs],
      },
      granted_by: input.grantedBy,
      granted_at: grantedAt,
      expires_at: input.expiresAt,
      status: "active",
    } satisfies DiscoveryAuthorization;
    assertContract("discovery-authorization", authorization);
    const stored = immutableCopy(authorization);
    this.#authorizations.set(stored.authorization_id, stored);
    return stored;
  }

  endDiscovery(authorizationId: string): DiscoveryAuthorization {
    if (!this.#persistentTransactionActive && this.#persistence !== undefined) {
      return this.#withPersistentState(() => this.endDiscovery(authorizationId));
    }
    const authorization = this.#authorizations.get(authorizationId);
    if (authorization === undefined || authorization.status !== "active") {
      throw new Error("DISCOVERY_AUTHORIZATION_NOT_ACTIVE");
    }
    const ended = immutableCopy({ ...authorization, status: "ended" as const });
    this.#authorizations.set(authorizationId, ended);
    for (const [token, request] of this.#confirmationsByToken) {
      if (request.authorizationId === authorizationId) {
        this.#confirmationsByToken.delete(token);
      }
    }
    for (const receipt of this.#receipts.values()) {
      if (
        receipt.authorizationId === authorizationId &&
        !receipt.consumed &&
        receipt.artifact === null
      ) {
        receipt.invalidated = true;
      }
    }
    return ended;
  }

  createCandidate(input: CandidateRevisionInput): AuthorityCandidate {
    if (!this.#persistentTransactionActive && this.#persistence !== undefined) {
      return this.#withPersistentState(() => this.createCandidate(input));
    }
    const authorization = this.#requireActiveAuthorization(input.authorizationId);
    this.#assertAuthorityBase({ ...input, instanceId: authorization.instance_id });
    if (!authorization.scope.candidate_types.includes(input.candidateType)) {
      throw new Error("DISCOVERY_CANDIDATE_TYPE_OUT_OF_SCOPE");
    }
    const sourceMap = normalizeCandidateSourceMap(authorization, input.sourceMap);
    const targetKey = [
      authorization.instance_id,
      input.candidateType,
      input.stableId,
    ].join("\u0000");
    const existingCandidateId = this.#candidateIdsByTarget.get(targetKey);
    if (
      existingCandidateId !== undefined &&
      this.#candidateAuthorizations.get(existingCandidateId) === input.authorizationId
    ) {
      throw new Error("CANDIDATE_TARGET_ALREADY_EXISTS");
    }
    const candidateId = existingCandidateId ?? this.#createId("candidate");
    if (existingCandidateId === undefined && this.#candidates.has(candidateId)) {
      throw new Error("CANDIDATE_ALREADY_EXISTS");
    }
    const existingRevisions = this.#candidates.get(candidateId);
    const current = existingRevisions?.at(-1);
    const stored = createCandidateRevision({
      candidateId,
      revision: (current?.revision ?? 0) + 1,
      candidateType: input.candidateType,
      stableId: input.stableId,
      baseAuthorityVersion: input.baseAuthorityVersion,
      baseChecksum: input.baseChecksum,
      baseContent: input.baseContent,
      content: input.content,
      sourceMap,
      createdAt: this.#now().toISOString(),
    });
    if (existingRevisions !== undefined) {
      this.#invalidateCandidateApprovals(candidateId);
    }
    this.#candidates.set(stored.candidate_id, [
      ...(existingRevisions ?? []),
      stored,
    ]);
    this.#candidateAuthorizations.set(stored.candidate_id, input.authorizationId);
    this.#candidateIdsByTarget.set(targetKey, stored.candidate_id);
    return stored;
  }

  reviseCandidate(input: CandidateRewriteInput): AuthorityCandidate {
    if (!this.#persistentTransactionActive && this.#persistence !== undefined) {
      return this.#withPersistentState(() => this.reviseCandidate(input));
    }
    const authorization = this.#requireActiveAuthorization(input.authorizationId);
    const revisions = this.#candidates.get(input.candidateId);
    const current = revisions?.at(-1);
    if (
      revisions === undefined ||
      current === undefined ||
      this.#candidateAuthorizations.get(input.candidateId) !== input.authorizationId
    ) {
      throw new Error("CANDIDATE_NOT_FOUND");
    }
    this.#assertAuthorityBase({
      ...input,
      instanceId: authorization.instance_id,
      candidateType: current.candidate_type,
      stableId: current.stable_id,
    });
    const sourceMap = normalizeCandidateSourceMap(authorization, input.sourceMap);
    const stored = createCandidateRevision({
      candidateId: current.candidate_id,
      revision: current.revision + 1,
      candidateType: current.candidate_type,
      stableId: current.stable_id,
      baseAuthorityVersion: input.baseAuthorityVersion,
      baseChecksum: input.baseChecksum,
      baseContent: input.baseContent,
      content: input.content,
      sourceMap,
      createdAt: this.#now().toISOString(),
    });
    this.#invalidateCandidateApprovals(input.candidateId);
    this.#candidates.set(input.candidateId, [...revisions, stored]);
    return stored;
  }

  prepareConfirmation(input: ConfirmationPreparationInput): ConfirmationPreparation {
    if (!this.#persistentTransactionActive && this.#persistence !== undefined) {
      return this.#withPersistentState(() => this.prepareConfirmation(input));
    }
    if (input.channel !== "telegram") {
      return { status: "redirect_required", confirmedChannel: "telegram" };
    }
    this.#requireActiveAuthorization(input.authorizationId);
    const revisions = this.#candidates.get(input.candidateId);
    const candidate = revisions
      ?.find((revision) => revision.revision === input.revision);
    if (
      candidate === undefined || candidate !== revisions?.at(-1) ||
      this.#candidateAuthorizations.get(input.candidateId) !== input.authorizationId
    ) {
      throw new Error("CANDIDATE_REVISION_NOT_FOUND");
    }
    const [reviewSource, ...reviewSources] = candidate.source_map;
    const reviewArtifact = {
      schema_version: "cognitive-runtime.candidate-review-artifact/v2",
      review_id: this.#createId("review"),
      candidate_id: candidate.candidate_id,
      candidate_revision: candidate.revision,
      candidate_checksum: candidate.checksum,
      complete_candidate: structuredClone(candidate.content),
      base_authority_version: candidate.base_authority_version,
      exact_diff: candidate.exact_diff,
      source_map: [
        {
          source_ref: reviewSource.source_ref,
          content_path: reviewSource.content_path,
        },
        ...reviewSources.map((entry) => ({
          source_ref: entry.source_ref,
          content_path: entry.content_path,
        })),
      ],
      created_at: this.#now().toISOString(),
    } satisfies CandidateReviewArtifact;
    assertContract("candidate-review-artifact", reviewArtifact);
    const requestId = this.#createId("request");
    const routingToken = this.#createRoutingToken();
    if (routingToken.length < 32 || this.#confirmationsByToken.has(routingToken)) {
      throw new Error("CONFIRMATION_ROUTING_TOKEN_INVALID");
    }
    this.#confirmationsByToken.set(routingToken, {
      authorizationId: input.authorizationId,
      requestId,
      candidate,
      reviewArtifact: immutableCopy(reviewArtifact),
      routingToken,
      messageReference: null,
    });
    return immutableCopy({
      status: "ready" as const,
      requestId,
      routingToken,
      reviewArtifact,
    });
  }

  bindConfirmationMessage(input: BindConfirmationMessageInput): void {
    if (!this.#persistentTransactionActive && this.#persistence !== undefined) {
      return this.#withPersistentState(() => this.bindConfirmationMessage(input));
    }
    const request = this.#confirmationsByToken.get(input.routingToken);
    if (request === undefined) {
      throw new Error("CONFIRMATION_ROUTING_TOKEN_INVALID");
    }
    const authorization = this.#requireActiveAuthorization(request.authorizationId);
    assertContract("approval-message-reference", input.messageReference);
    if (input.messageReference.instance_id !== authorization.instance_id) {
      throw new Error("CONFIRMATION_MESSAGE_MISMATCH");
    }
    if (
      request.messageReference !== null &&
      !sameMessageReference(request.messageReference, input.messageReference)
    ) {
      throw new Error("CONFIRMATION_MESSAGE_ALREADY_BOUND");
    }
    request.messageReference = immutableCopy(input.messageReference);
  }

  confirmationInstanceId(routingToken: string): string {
    if (!this.#persistentTransactionActive && this.#persistence !== undefined) {
      return this.#withPersistentState(() => this.confirmationInstanceId(routingToken));
    }
    const request = this.#confirmationsByToken.get(routingToken);
    if (request === undefined) {
      throw new Error("CONFIRMATION_ROUTING_TOKEN_INVALID");
    }
    return this.#requireActiveAuthorization(request.authorizationId).instance_id;
  }

  withdrawConfirmation(routingToken: string): void {
    if (!this.#persistentTransactionActive && this.#persistence !== undefined) {
      return this.#withPersistentState(() => this.withdrawConfirmation(routingToken));
    }
    if (!this.#confirmationsByToken.delete(routingToken)) {
      throw new Error("CONFIRMATION_ROUTING_TOKEN_INVALID");
    }
  }

  decideConfirmation(input: ConfirmationDecisionInput): ConfirmationDecision {
    if (!this.#persistentTransactionActive && this.#persistence !== undefined) {
      return this.#withPersistentState(() => this.decideConfirmation(input));
    }
    if (!isConfirmationAction(input.action)) {
      throw new Error("CONFIRMATION_ACTION_UNSUPPORTED");
    }
    const request = this.#confirmationsByToken.get(input.routingToken);
    if (request === undefined) {
      throw new Error("CONFIRMATION_ROUTING_TOKEN_INVALID");
    }
    const authorization = this.#requireActiveAuthorization(request.authorizationId);
    if (request.messageReference === null) {
      throw new Error("CONFIRMATION_MESSAGE_NOT_BOUND");
    }
    if (!sameMessageReference(request.messageReference, input.messageReference)) {
      throw new Error("CONFIRMATION_MESSAGE_MISMATCH");
    }
    if (!input.authorized || input.senderId !== authorization.granted_by) {
      throw new Error("CONFIRMATION_ACTOR_MISMATCH");
    }
    this.#confirmationsByToken.delete(input.routingToken);
    if (input.action === "request-rewrite") {
      return immutableCopy({
        status: "rewrite_requested" as const,
        candidateId: request.candidate.candidate_id,
        candidateRevision: request.candidate.revision,
      });
    }
    const receipt = {
      schema_version: "cognitive-runtime.decision-receipt/v2",
      receipt_id: this.#createId("receipt"),
      request_id: request.requestId,
      candidate_id: request.candidate.candidate_id,
      candidate_revision: request.candidate.revision,
      candidate_checksum: request.candidate.checksum,
      base_authority_version: request.candidate.base_authority_version,
      decision: input.action === "reject"
        ? "rejected"
        : request.candidate.revision === 1 ? "accepted" : "rewritten",
      decided_by: input.senderId,
      message_reference: {
        provider: "telegram" as const,
        instance_id: input.messageReference.instance_id,
        account_id: input.messageReference.account_id,
        conversation_id: input.messageReference.conversation_id,
        message_id: input.messageReference.message_id,
      },
      decided_at: this.#now().toISOString(),
      single_use: true as const,
    } satisfies DecisionReceipt;
    assertContract("decision-receipt", receipt);
    const stored = immutableCopy(receipt);
    this.#receipts.set(stored.receipt_id, {
      authorizationId: request.authorizationId,
      receipt: stored,
      consumed: false,
      invalidated: false,
      artifact: null,
      finalization: null,
    });
    if (stored.decision !== "rejected") {
      (this.#instanceLifecycles.get(authorization.instance_id) ?? this.#lifecycle)
        ?.recordLifecycle("accepted");
    }
    return immutableCopy({ status: "decided" as const, receipt: stored });
  }

  consumeApprovalReceiptForCandidate(
    candidateId: string,
    candidateRevision: number,
  ): DecisionReceipt {
    if (!this.#persistentTransactionActive && this.#persistence !== undefined) {
      return this.#withPersistentState(() =>
        this.consumeApprovalReceiptForCandidate(candidateId, candidateRevision));
    }
    for (const record of this.#receipts.values()) {
      if (
        !record.invalidated &&
        !record.consumed &&
        record.receipt.candidate_id === candidateId &&
        record.receipt.candidate_revision === candidateRevision &&
        record.receipt.decision !== "rejected"
      ) {
        return this.consumeApprovalReceipt({
          receiptId: record.receipt.receipt_id,
          candidateId,
          candidateRevision,
          candidateChecksum: record.receipt.candidate_checksum,
          baseAuthorityVersion: record.receipt.base_authority_version,
        });
      }
    }
    throw new Error("APPROVAL_RECEIPT_INVALID");
  }

  consumeApprovalReceipt(input: ApprovalReceiptConsumptionInput): DecisionReceipt {
    if (!this.#persistentTransactionActive && this.#persistence !== undefined) {
      return this.#withPersistentState(() => this.consumeApprovalReceipt(input));
    }
    const record = this.#receipts.get(input.receiptId);
    if (record === undefined || record.invalidated) {
      throw new Error("APPROVAL_RECEIPT_INVALID");
    }
    if (record.consumed) {
      throw new Error("APPROVAL_RECEIPT_ALREADY_CONSUMED");
    }
    if (record.artifact !== null) {
      throw new Error("APPROVAL_RECEIPT_ALREADY_PREPARED");
    }
    let authorization: DiscoveryAuthorization;
    try {
      authorization = this.#requireActiveAuthorization(record.authorizationId);
    } catch {
      record.invalidated = true;
      throw new Error("APPROVAL_RECEIPT_INVALID");
    }
    if (record.receipt.decision === "rejected") {
      throw new Error("APPROVAL_RECEIPT_NOT_APPROVED");
    }
    if (
      record.receipt.candidate_id !== input.candidateId ||
      record.receipt.candidate_revision !== input.candidateRevision ||
      record.receipt.candidate_checksum !== input.candidateChecksum ||
      record.receipt.base_authority_version !== input.baseAuthorityVersion
    ) {
      throw new Error("APPROVAL_RECEIPT_CANDIDATE_MISMATCH");
    }
    const candidate = this.#candidates.get(input.candidateId)
      ?.find((revision) => revision.revision === input.candidateRevision);
    if (candidate === undefined) {
      record.invalidated = true;
      throw new Error("APPROVAL_RECEIPT_INVALID");
    }
    try {
      this.#assertCurrentAuthorityHead(candidate, authorization.instance_id);
    } catch {
      record.invalidated = true;
      throw new Error("APPROVAL_RECEIPT_INVALID");
    }
    record.consumed = true;
    return record.receipt;
  }

  #withPersistentState<T>(operation: () => T): T {
    const persistence = this.#persistence;
    if (persistence === undefined) return operation();
    return persistence.transact((stored) => {
      this.#restoreSnapshot(parseCandidateAdmissionSnapshot(stored));
      this.#persistentTransactionActive = true;
      try {
        const result = operation();
        return { snapshot: this.#createSnapshot(), result };
      } finally {
        this.#persistentTransactionActive = false;
      }
    });
  }

  #createSnapshot(): CandidateAdmissionSnapshot {
    return immutableCopy({
      schemaVersion: "stella-runtime.candidate-admission-store/v1" as const,
      authorizations: [...this.#authorizations.values()],
      candidates: [...this.#candidates.entries()].map(([candidateId, revisions]) => ({
        candidateId,
        authorizationId: this.#candidateAuthorizations.get(candidateId) ?? "",
        revisions,
      })),
      candidateTargets: [...this.#candidateIdsByTarget.entries()].map(
        ([targetKey, candidateId]) => ({ targetKey, candidateId }),
      ),
      confirmations: [...this.#confirmationsByToken.values()],
      receipts: [...this.#receipts.values()],
    });
  }

  #restoreSnapshot(snapshot: CandidateAdmissionSnapshot): void {
    this.#authorizations.clear();
    this.#candidates.clear();
    this.#candidateAuthorizations.clear();
    this.#candidateIdsByTarget.clear();
    this.#confirmationsByToken.clear();
    this.#receipts.clear();
    for (const authorization of snapshot.authorizations) {
      this.#authorizations.set(authorization.authorization_id, immutableCopy(authorization));
    }
    for (const record of snapshot.candidates) {
      if (
        record.authorizationId.length === 0 ||
        !this.#authorizations.has(record.authorizationId)
      ) throw new Error("CANDIDATE_ADMISSION_STORE_INVALID");
      this.#candidates.set(record.candidateId, immutableCopy(record.revisions));
      this.#candidateAuthorizations.set(record.candidateId, record.authorizationId);
    }
    for (const target of snapshot.candidateTargets) {
      if (!this.#candidates.has(target.candidateId)) {
        throw new Error("CANDIDATE_ADMISSION_STORE_INVALID");
      }
      this.#candidateIdsByTarget.set(target.targetKey, target.candidateId);
    }
    for (const confirmation of snapshot.confirmations) {
      if (
        !this.#authorizations.has(confirmation.authorizationId) ||
        this.#confirmationsByToken.has(confirmation.routingToken)
      ) throw new Error("CANDIDATE_ADMISSION_STORE_INVALID");
      this.#confirmationsByToken.set(confirmation.routingToken, {
        ...immutableCopy(confirmation),
      });
    }
    for (const receipt of snapshot.receipts) {
      if (
        !this.#authorizations.has(receipt.authorizationId) ||
        this.#receipts.has(receipt.receipt.receipt_id)
      ) throw new Error("CANDIDATE_ADMISSION_STORE_INVALID");
      this.#receipts.set(receipt.receipt.receipt_id, {
        ...immutableCopy(receipt),
      });
    }
  }

  #invalidateCandidateApprovals(candidateId: string): void {
    for (const [token, request] of this.#confirmationsByToken) {
      if (request.candidate.candidate_id === candidateId) {
        this.#confirmationsByToken.delete(token);
      }
    }
    for (const receipt of this.#receipts.values()) {
      if (
        receipt.receipt.candidate_id === candidateId &&
        !receipt.consumed &&
        receipt.artifact === null
      ) {
        receipt.invalidated = true;
      }
    }
  }

  #assertAuthorityBase(input: {
    readonly instanceId: string;
    readonly candidateType: CandidateType;
    readonly stableId: string;
    readonly baseAuthorityVersion: string | null;
    readonly baseChecksum: string | null;
    readonly baseContent: Readonly<Record<string, unknown>> | null;
  }): void {
    assertCandidateBase(
      input.baseAuthorityVersion,
      input.baseChecksum,
      input.baseContent,
    );
    this.#assertAuthorityHeadMatches(input);
  }

  #assertCurrentAuthorityHead(
    candidate: AuthorityCandidate,
    instanceId: string,
  ): void {
    this.#assertAuthorityHeadMatches({
      instanceId,
      candidateType: candidate.candidate_type,
      stableId: candidate.stable_id,
      baseAuthorityVersion: candidate.base_authority_version,
      baseChecksum: candidate.base_checksum,
    });
  }

  #assertAuthorityHeadMatches(input: {
    readonly instanceId: string;
    readonly candidateType: CandidateType;
    readonly stableId: string;
    readonly baseAuthorityVersion: string | null;
    readonly baseChecksum: string | null;
  }): void {
    const current = this.#authorityHead.getCurrent({
      instanceId: input.instanceId,
      candidateType: input.candidateType,
      stableId: input.stableId,
    });
    if (
      (current === null && input.baseAuthorityVersion !== null) ||
      (current !== null && (
        current.version !== input.baseAuthorityVersion ||
        current.checksum !== input.baseChecksum
      ))
    ) {
      throw new Error("CANDIDATE_BASE_MISMATCH");
    }
  }

  #requireActiveAuthorization(authorizationId: string): DiscoveryAuthorization {
    const authorization = this.#authorizations.get(authorizationId);
    if (
      authorization === undefined ||
      authorization.status !== "active" ||
      Date.parse(authorization.expires_at) <= this.#now().getTime()
    ) {
      throw new Error("DISCOVERY_AUTHORIZATION_NOT_ACTIVE");
    }
    return authorization;
  }
}
