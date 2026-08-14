import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTelegramConfirmationActions,
  CandidateAdmissionService,
  createOpenClawTelegramConfirmationPresentation,
  OPENCLAW_TELEGRAM_CONFIRMATION_VERSION,
  presentTelegramConfirmation,
  registerTelegramConfirmationGateway,
  TELEGRAM_CONFIRMATION_NAMESPACE,
} from "../../dist/index.js";

test("exact OpenClaw Telegram callbacks make deterministic decisions without LLM execution", async () => {
  let sequence = 0;
  const service = new CandidateAdmissionService({
    now: () => new Date("2026-08-14T01:00:00.000Z"),
    createId: (kind) => `${kind}-telegram-${++sequence}`,
    createRoutingToken: () => "abcdefghijklmnopqrstuvwxyzABCDEFGH012345678",
    authorityHead: { getCurrent: () => null },
  });
  const authorization = service.authorizeDiscovery({
    instanceId: "instance-synthetic",
    scope: {
      candidateTypes: ["semantic"],
      sourceRefs: ["src-synthetic-note"],
    },
    grantedBy: "owner-synthetic",
    expiresAt: "2026-08-14T02:00:00.000Z",
  });
  const candidate = service.createCandidate({
    authorizationId: authorization.authorization_id,
    candidateType: "semantic",
    stableId: "sem-synthetic",
    baseAuthorityVersion: null,
    baseChecksum: null,
    baseContent: null,
    content: { claim: "A bounded claim." },
    sourceMap: [{ sourceRef: "src-synthetic-note", contentPath: "body" }],
  });
  const presentations = [];
  const confirmation = await presentTelegramConfirmation({
    service,
    input: {
      authorizationId: authorization.authorization_id,
      candidateId: candidate.candidate_id,
      revision: candidate.revision,
      channel: "telegram",
    },
    presentation: {
      async present(input) {
        presentations.push(input);
        return {
          schema_version: "cognitive-runtime.approval-message-reference/v2",
          provider: "telegram",
          instance_id: "instance-synthetic",
          account_id: "account-synthetic",
          conversation_id: "conversation-synthetic",
          message_id: "42",
        };
      },
    },
  });
  assert.equal(confirmation.status, "presented");
  assert.match(presentations[0].text, /Complete Candidate:\n[\s\S]*A bounded claim/);
  assert.match(presentations[0].text, /Exact Base Diff:/);
  assert.match(presentations[0].text, /Source Map:/);

  const actions = presentations[0].actions;
  assert.deepEqual(actions.map((action) => action.text), [
    "接受此版本",
    "拒绝此版本",
    "请求改写",
  ]);
  assert.ok(actions.every((action) => Buffer.byteLength(action.callbackData) <= 64));

  const registered = [];
  registerTelegramConfirmationGateway({
    api: {
      registerInteractiveHandler(registration) {
        registered.push(registration);
      },
    },
    service,
    hostVersion: OPENCLAW_TELEGRAM_CONFIRMATION_VERSION,
  });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].channel, "telegram");
  assert.equal(registered[0].namespace, TELEGRAM_CONFIRMATION_NAMESPACE);

  const replies = [];
  const result = await registered[0].handler({
    channel: "telegram",
    accountId: "account-synthetic",
    conversationId: "conversation-synthetic",
    senderId: "owner-synthetic",
    auth: { isAuthorizedSender: true },
    callback: {
      namespace: TELEGRAM_CONFIRMATION_NAMESPACE,
      payload: actions[0].callbackData.split(":").slice(1).join(":"),
      messageId: 42,
    },
    respond: {
      async clearButtons() {
        replies.push("buttons-cleared");
      },
      async reply({ text }) {
        replies.push(text);
      },
    },
  });

  assert.deepEqual(result, { handled: true });
  assert.deepEqual(replies, ["buttons-cleared", "AUTHORITY_CANDIDATE_ACCEPTED"]);
});

test("Telegram confirmation registration fails closed for an unsmoked Host version", () => {
  const service = new CandidateAdmissionService();
  assert.throws(
    () => registerTelegramConfirmationGateway({
      api: { registerInteractiveHandler() {} },
      service,
      hostVersion: "2026.6.35",
    }),
    /TELEGRAM_CONFIRMATION_HOST_UNSUPPORTED/,
  );
});

test("OpenClaw outbound presentation binds the exact Telegram send receipt", async () => {
  const sends = [];
  const presentation = createOpenClawTelegramConfirmationPresentation({
    runtime: {
      config: { current: () => ({ synthetic: true }) },
      channel: {
        outbound: {
          async loadAdapter(channel) {
            assert.equal(channel, "telegram");
            return {
              async sendPayload(input) {
                sends.push(input);
                return { messageId: "84", chatId: "chat-host-receipt" };
              },
            };
          },
        },
      },
    },
    instanceId: "instance-synthetic",
    accountId: "account-synthetic",
    conversationId: "conversation-requested",
  });
  const reference = await presentation.present({
    reviewArtifact: {},
    text: "Complete Candidate: synthetic",
    actions: buildTelegramConfirmationActions(
      "abcdefghijklmnopqrstuvwxyzABCDEFGH012345678",
    ),
  });
  assert.equal(sends[0].to, "conversation-requested");
  assert.equal(sends[0].payload.presentation.blocks[1].buttons.length, 3);
  assert.deepEqual(reference, {
    schema_version: "cognitive-runtime.approval-message-reference/v2",
    provider: "telegram",
    instance_id: "instance-synthetic",
    account_id: "account-synthetic",
    conversation_id: "chat-host-receipt",
    message_id: "84",
  });
});
