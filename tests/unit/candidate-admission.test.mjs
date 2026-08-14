import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateCandidateContentChecksum,
  calculateCandidateExactDiff,
  CandidateAdmissionService,
} from "../../dist/index.js";

const instant = "2026-08-14T01:00:00.000Z";

const createService = () => {
  let sequence = 0;
  return new CandidateAdmissionService({
    now: () => new Date(instant),
    createId: (kind) => `${kind}-synthetic-${++sequence}`,
    createRoutingToken: () => `routing-token-${String(++sequence).padStart(64, "0")}`,
    authorityHead: { getCurrent: () => null },
  });
};

const authorizationInput = {
  instanceId: "instance-synthetic",
  scope: {
    candidateTypes: ["semantic"],
    sourceRefs: ["src-synthetic-note"],
  },
  grantedBy: "owner-synthetic",
  expiresAt: "2026-08-14T02:00:00.000Z",
};

const candidateInput = {
  candidateType: "semantic",
  stableId: "sem-synthetic",
  baseAuthorityVersion: null,
  baseChecksum: null,
  baseContent: null,
  content: { title: "Synthetic", claim: "A bounded claim." },
  sourceMap: [{ sourceRef: "src-synthetic-note", contentPath: "body" }],
};

test("candidate discovery requires one live finite authorization and enforces its scope", () => {
  const service = createService();

  assert.throws(
    () => service.createCandidate({
      authorizationId: "authorization-missing",
      ...candidateInput,
    }),
    /DISCOVERY_AUTHORIZATION_NOT_ACTIVE/,
  );

  const authorization = service.authorizeDiscovery(authorizationInput);
  assert.equal(authorization.status, "active");
  assert.equal(authorization.authorization_id, "authorization-synthetic-1");

  assert.throws(
    () => service.createCandidate({
      authorizationId: authorization.authorization_id,
      ...candidateInput,
      candidateType: "cognitive",
    }),
    /DISCOVERY_CANDIDATE_TYPE_OUT_OF_SCOPE/,
  );
  assert.throws(
    () => service.createCandidate({
      authorizationId: authorization.authorization_id,
      ...candidateInput,
      sourceMap: [{ sourceRef: "src-unapproved", contentPath: "body" }],
    }),
    /DISCOVERY_SOURCE_REF_OUT_OF_SCOPE/,
  );

  const candidate = service.createCandidate({
    authorizationId: authorization.authorization_id,
    ...candidateInput,
  });
  assert.equal(candidate.revision, 1);
  assert.match(candidate.checksum, /^sha256:[a-f0-9]{64}$/);

  const ended = service.endDiscovery(authorization.authorization_id);
  assert.equal(ended.status, "ended");
  assert.throws(
    () => service.createCandidate({
      authorizationId: authorization.authorization_id,
      ...candidateInput,
    }),
    /DISCOVERY_AUTHORIZATION_NOT_ACTIVE/,
  );
});

test("Candidate discovery fails closed until an Authority Head port is configured", () => {
  const service = new CandidateAdmissionService({
    now: () => new Date(instant),
  });
  const authorization = service.authorizeDiscovery(authorizationInput);
  assert.throws(
    () => service.createCandidate({
      authorizationId: authorization.authorization_id,
      ...candidateInput,
    }),
    /CANDIDATE_AUTHORITY_HEAD_UNAVAILABLE/,
  );
});

test("rewrites preserve Candidate identity while creating immutable checksummed revisions and complete reviews", () => {
  const service = createService();
  const authorization = service.authorizeDiscovery(authorizationInput);
  const first = service.createCandidate({
    authorizationId: authorization.authorization_id,
    ...candidateInput,
  });
  const second = service.reviseCandidate({
    authorizationId: authorization.authorization_id,
    candidateId: first.candidate_id,
    baseAuthorityVersion: null,
    baseChecksum: null,
    baseContent: null,
    content: { title: "Synthetic", claim: "A rewritten bounded claim." },
    sourceMap: [{ sourceRef: "src-synthetic-note", contentPath: "body" }],
  });

  assert.equal(second.candidate_id, first.candidate_id);
  assert.equal(second.stable_id, first.stable_id);
  assert.equal(second.candidate_type, first.candidate_type);
  assert.equal(second.revision, 2);
  assert.notEqual(second.checksum, first.checksum);
  assert.equal(
    second.exact_diff,
    calculateCandidateExactDiff(null, second.content),
  );
  assert.equal(Object.isFrozen(second), true);
  assert.equal(Object.isFrozen(second.content), true);
  assert.throws(() => {
    second.content.claim = "mutated";
  }, TypeError);

  const confirmation = service.prepareConfirmation({
    authorizationId: authorization.authorization_id,
    candidateId: second.candidate_id,
    revision: second.revision,
    channel: "telegram",
  });
  assert.equal(confirmation.status, "ready");
  assert.deepEqual(confirmation.reviewArtifact.complete_candidate, second.content);
  assert.equal(confirmation.reviewArtifact.candidate_checksum, second.checksum);
  assert.equal(confirmation.reviewArtifact.base_authority_version, null);
  assert.equal(confirmation.reviewArtifact.exact_diff, second.exact_diff);
  assert.deepEqual(confirmation.reviewArtifact.source_map, second.source_map);

  const redirect = service.prepareConfirmation({
    authorizationId: authorization.authorization_id,
    candidateId: second.candidate_id,
    revision: second.revision,
    channel: "slack",
  });
  assert.deepEqual(redirect, {
    status: "redirect_required",
    confirmedChannel: "telegram",
  });
});

const messageReference = {
  schema_version: "cognitive-runtime.approval-message-reference/v2",
  provider: "telegram",
  instance_id: "instance-synthetic",
  account_id: "account-synthetic",
  conversation_id: "conversation-synthetic",
  message_id: "42",
};

const openConfirmation = (service) => {
  const authorization = service.authorizeDiscovery(authorizationInput);
  const candidate = service.createCandidate({
    authorizationId: authorization.authorization_id,
    ...candidateInput,
  });
  const confirmation = service.prepareConfirmation({
    authorizationId: authorization.authorization_id,
    candidateId: candidate.candidate_id,
    revision: candidate.revision,
    channel: "telegram",
  });
  assert.equal(confirmation.status, "ready");
  service.bindConfirmationMessage({
    routingToken: confirmation.routingToken,
    messageReference,
  });
  return { authorization, candidate, confirmation };
};

test("only an exact authorized Telegram callback can issue a single-use Approval Receipt", () => {
  const service = createService();
  const { candidate, confirmation } = openConfirmation(service);
  const callback = {
    routingToken: confirmation.routingToken,
    action: "accept",
    authorized: true,
    senderId: "owner-synthetic",
    messageReference,
  };

  assert.throws(
    () => service.decideConfirmation({ ...callback, action: "yes please" }),
    /CONFIRMATION_ACTION_UNSUPPORTED/,
  );
  assert.throws(
    () => service.decideConfirmation({
      ...callback,
      messageReference: { ...messageReference, message_id: "43" },
    }),
    /CONFIRMATION_MESSAGE_MISMATCH/,
  );
  assert.throws(
    () => service.decideConfirmation({ ...callback, senderId: "other-user" }),
    /CONFIRMATION_ACTOR_MISMATCH/,
  );

  const decision = service.decideConfirmation(callback);
  assert.equal(decision.status, "decided");
  assert.equal(decision.receipt.decision, "accepted");
  assert.equal(decision.receipt.candidate_id, candidate.candidate_id);
  assert.equal(decision.receipt.candidate_revision, candidate.revision);
  assert.equal(decision.receipt.candidate_checksum, candidate.checksum);
  assert.deepEqual(decision.receipt.message_reference, {
    provider: "telegram",
    instance_id: "instance-synthetic",
    account_id: "account-synthetic",
    conversation_id: "conversation-synthetic",
    message_id: "42",
  });

  assert.throws(
    () => service.consumeApprovalReceipt({
      receiptId: decision.receipt.receipt_id,
      candidateId: candidate.candidate_id,
      candidateRevision: candidate.revision,
      candidateChecksum: `sha256:${"0".repeat(64)}`,
      baseAuthorityVersion: candidate.base_authority_version,
    }),
    /APPROVAL_RECEIPT_CANDIDATE_MISMATCH/,
  );
  service.consumeApprovalReceipt({
    receiptId: decision.receipt.receipt_id,
    candidateId: candidate.candidate_id,
    candidateRevision: candidate.revision,
    candidateChecksum: candidate.checksum,
    baseAuthorityVersion: candidate.base_authority_version,
  });
  assert.throws(
    () => service.consumeApprovalReceipt({
      receiptId: decision.receipt.receipt_id,
      candidateId: candidate.candidate_id,
      candidateRevision: candidate.revision,
      candidateChecksum: candidate.checksum,
      baseAuthorityVersion: candidate.base_authority_version,
    }),
    /APPROVAL_RECEIPT_ALREADY_CONSUMED/,
  );
  assert.throws(
    () => service.decideConfirmation(callback),
    /CONFIRMATION_ROUTING_TOKEN_INVALID/,
  );
});

test("workflow end and rewrite requests invalidate unresolved routing capabilities", () => {
  const endedService = createService();
  const ended = openConfirmation(endedService);
  endedService.endDiscovery(ended.authorization.authorization_id);
  assert.throws(
    () => endedService.decideConfirmation({
      routingToken: ended.confirmation.routingToken,
      action: "accept",
      authorized: true,
      senderId: "owner-synthetic",
      messageReference,
    }),
    /CONFIRMATION_ROUTING_TOKEN_INVALID/,
  );

  const rewriteService = createService();
  const rewrite = openConfirmation(rewriteService);
  const feedback = rewriteService.decideConfirmation({
    routingToken: rewrite.confirmation.routingToken,
    action: "request-rewrite",
    authorized: true,
    senderId: "owner-synthetic",
    messageReference,
  });
  assert.deepEqual(feedback, {
    status: "rewrite_requested",
    candidateId: rewrite.candidate.candidate_id,
    candidateRevision: rewrite.candidate.revision,
  });
  assert.equal("receipt" in feedback, false);
  assert.throws(
    () => rewriteService.decideConfirmation({
      routingToken: rewrite.confirmation.routingToken,
      action: "accept",
      authorized: true,
      senderId: "owner-synthetic",
      messageReference,
    }),
    /CONFIRMATION_ROUTING_TOKEN_INVALID/,
  );
});

test("a new Candidate revision invalidates older requests and unconsumed receipts", () => {
  const requestService = createService();
  const pending = openConfirmation(requestService);
  requestService.reviseCandidate({
    authorizationId: pending.authorization.authorization_id,
    candidateId: pending.candidate.candidate_id,
    baseAuthorityVersion: null,
    baseChecksum: null,
    baseContent: null,
    content: { claim: "Changed after presentation." },
    sourceMap: [{ sourceRef: "src-synthetic-note", contentPath: "body" }],
  });
  assert.throws(
    () => requestService.decideConfirmation({
      routingToken: pending.confirmation.routingToken,
      action: "accept",
      authorized: true,
      senderId: "owner-synthetic",
      messageReference,
    }),
    /CONFIRMATION_ROUTING_TOKEN_INVALID/,
  );

  const receiptService = createService();
  const accepted = openConfirmation(receiptService);
  const decision = receiptService.decideConfirmation({
    routingToken: accepted.confirmation.routingToken,
    action: "accept",
    authorized: true,
    senderId: "owner-synthetic",
    messageReference,
  });
  assert.equal(decision.status, "decided");
  receiptService.reviseCandidate({
    authorizationId: accepted.authorization.authorization_id,
    candidateId: accepted.candidate.candidate_id,
    baseAuthorityVersion: null,
    baseChecksum: null,
    baseContent: null,
    content: { claim: "Changed after acceptance." },
    sourceMap: [{ sourceRef: "src-synthetic-note", contentPath: "body" }],
  });
  assert.throws(
    () => receiptService.consumeApprovalReceipt({
      receiptId: decision.receipt.receipt_id,
      candidateId: accepted.candidate.candidate_id,
      candidateRevision: accepted.candidate.revision,
      candidateChecksum: accepted.candidate.checksum,
      baseAuthorityVersion: accepted.candidate.base_authority_version,
    }),
    /APPROVAL_RECEIPT_INVALID/,
  );
});

test("reject cannot publish while an accepted rewritten revision is identified exactly", () => {
  const rejectedService = createService();
  const rejected = openConfirmation(rejectedService);
  const rejection = rejectedService.decideConfirmation({
    routingToken: rejected.confirmation.routingToken,
    action: "reject",
    authorized: true,
    senderId: "owner-synthetic",
    messageReference,
  });
  assert.equal(rejection.status, "decided");
  assert.equal(rejection.receipt.decision, "rejected");
  assert.throws(
    () => rejectedService.consumeApprovalReceipt({
      receiptId: rejection.receipt.receipt_id,
      candidateId: rejected.candidate.candidate_id,
      candidateRevision: rejected.candidate.revision,
      candidateChecksum: rejected.candidate.checksum,
      baseAuthorityVersion: rejected.candidate.base_authority_version,
    }),
    /APPROVAL_RECEIPT_NOT_APPROVED/,
  );

  const rewrittenService = createService();
  const original = openConfirmation(rewrittenService);
  rewrittenService.decideConfirmation({
    routingToken: original.confirmation.routingToken,
    action: "request-rewrite",
    authorized: true,
    senderId: "owner-synthetic",
    messageReference,
  });
  const rewritten = rewrittenService.reviseCandidate({
    authorizationId: original.authorization.authorization_id,
    candidateId: original.candidate.candidate_id,
    baseAuthorityVersion: null,
    baseChecksum: null,
    baseContent: null,
    content: { claim: "The owner's rewritten claim." },
    sourceMap: [{ sourceRef: "src-synthetic-note", contentPath: "body" }],
  });
  const confirmation = rewrittenService.prepareConfirmation({
    authorizationId: original.authorization.authorization_id,
    candidateId: rewritten.candidate_id,
    revision: rewritten.revision,
    channel: "telegram",
  });
  assert.equal(confirmation.status, "ready");
  rewrittenService.bindConfirmationMessage({
    routingToken: confirmation.routingToken,
    messageReference: { ...messageReference, message_id: "44" },
  });
  const decision = rewrittenService.decideConfirmation({
    routingToken: confirmation.routingToken,
    action: "accept",
    authorized: true,
    senderId: "owner-synthetic",
    messageReference: { ...messageReference, message_id: "44" },
  });
  assert.equal(decision.status, "decided");
  assert.equal(decision.receipt.decision, "rewritten");
  assert.equal(decision.receipt.candidate_revision, 2);
  assert.equal(decision.receipt.candidate_checksum, rewritten.checksum);
});

test("Candidate bases are checked against trusted Authority head state", () => {
  let now = new Date("2026-08-14T01:00:00.000Z");
  let sequence = 0;
  const baseContent = { claim: "Prior claim." };
  let authorityHead = {
    version: "semantic-v1",
    checksum: calculateCandidateContentChecksum(baseContent),
  };
  const headRequests = [];
  const service = new CandidateAdmissionService({
    now: () => now,
    createId: (kind) => `${kind}-expiry-${++sequence}`,
    createRoutingToken: () => `routing-token-${String(++sequence).padStart(64, "0")}`,
    authorityHead: {
      getCurrent(input) {
        headRequests.push(input);
        return authorityHead;
      },
    },
  });
  const authorization = service.authorizeDiscovery(authorizationInput);
  const candidate = service.createCandidate({
    authorizationId: authorization.authorization_id,
    ...candidateInput,
    baseAuthorityVersion: "semantic-v1",
    baseChecksum: calculateCandidateContentChecksum(baseContent),
    baseContent,
  });
  assert.equal(
    candidate.exact_diff,
    calculateCandidateExactDiff(baseContent, candidate.content),
  );
  assert.deepEqual(headRequests[0], {
    instanceId: "instance-synthetic",
    candidateType: "semantic",
    stableId: "sem-synthetic",
  });
  assert.throws(
    () => service.createCandidate({
      authorizationId: authorization.authorization_id,
      ...candidateInput,
      baseAuthorityVersion: "semantic-v1",
      baseChecksum: calculateCandidateContentChecksum(baseContent),
      baseContent,
    }),
    /CANDIDATE_TARGET_ALREADY_EXISTS/,
  );
  assert.throws(
    () => service.reviseCandidate({
      authorizationId: authorization.authorization_id,
      candidateId: candidate.candidate_id,
      baseAuthorityVersion: "semantic-v1",
      baseChecksum: `sha256:${"0".repeat(64)}`,
      baseContent,
      content: { claim: "Invalid base." },
      sourceMap: [{ sourceRef: "src-synthetic-note", contentPath: "body" }],
    }),
    /CANDIDATE_BASE_CHECKSUM_MISMATCH/,
  );

  const confirmation = service.prepareConfirmation({
    authorizationId: authorization.authorization_id,
    candidateId: candidate.candidate_id,
    revision: candidate.revision,
    channel: "telegram",
  });
  assert.equal(confirmation.status, "ready");
  service.bindConfirmationMessage({
    routingToken: confirmation.routingToken,
    messageReference,
  });
  const decision = service.decideConfirmation({
    routingToken: confirmation.routingToken,
    action: "accept",
    authorized: true,
    senderId: "owner-synthetic",
    messageReference,
  });
  assert.equal(decision.status, "decided");
  authorityHead = {
    version: "semantic-v2",
    checksum: `sha256:${"2".repeat(64)}`,
  };
  assert.throws(
    () => service.consumeApprovalReceipt({
      receiptId: decision.receipt.receipt_id,
      candidateId: candidate.candidate_id,
      candidateRevision: candidate.revision,
      candidateChecksum: candidate.checksum,
      baseAuthorityVersion: candidate.base_authority_version,
    }),
    /APPROVAL_RECEIPT_INVALID/,
  );
});

test("Candidate identity remains stable across bounded Discovery workflows", () => {
  const service = createService();
  const firstAuthorization = service.authorizeDiscovery(authorizationInput);
  const first = service.createCandidate({
    authorizationId: firstAuthorization.authorization_id,
    ...candidateInput,
  });
  service.endDiscovery(firstAuthorization.authorization_id);
  const secondAuthorization = service.authorizeDiscovery(authorizationInput);
  const second = service.createCandidate({
    authorizationId: secondAuthorization.authorization_id,
    ...candidateInput,
    content: { claim: "Rediscovered changed content." },
  });
  assert.equal(second.candidate_id, first.candidate_id);
  assert.equal(second.revision, 2);
  assert.notEqual(second.checksum, first.checksum);
  assert.throws(
    () => service.prepareConfirmation({
      authorizationId: secondAuthorization.authorization_id,
      candidateId: first.candidate_id,
      revision: first.revision,
      channel: "telegram",
    }),
    /CANDIDATE_REVISION_NOT_FOUND/,
  );
});

test("unconsumed Approval Receipts expire with their Discovery workflow", () => {
  let now = new Date("2026-08-14T01:00:00.000Z");
  let sequence = 0;
  const service = new CandidateAdmissionService({
    now: () => now,
    createId: (kind) => `${kind}-timeout-${++sequence}`,
    createRoutingToken: () => `routing-token-${String(++sequence).padStart(64, "0")}`,
    authorityHead: { getCurrent: () => null },
  });
  const { candidate, confirmation } = openConfirmation(service);
  const decision = service.decideConfirmation({
    routingToken: confirmation.routingToken,
    action: "accept",
    authorized: true,
    senderId: "owner-synthetic",
    messageReference,
  });
  assert.equal(decision.status, "decided");
  now = new Date("2026-08-14T02:00:00.000Z");
  assert.throws(
    () => service.consumeApprovalReceipt({
      receiptId: decision.receipt.receipt_id,
      candidateId: candidate.candidate_id,
      candidateRevision: candidate.revision,
      candidateChecksum: candidate.checksum,
      baseAuthorityVersion: candidate.base_authority_version,
    }),
    /APPROVAL_RECEIPT_INVALID/,
  );
});
