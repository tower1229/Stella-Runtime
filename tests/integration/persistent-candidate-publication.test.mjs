import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  calculatePublicationContentChecksum,
  CandidateAdmissionService,
  ChangeSetPublicationCoordinator,
  createChangeSet,
  FileCandidateAdmissionStore,
  FilePublicationJournal,
  OPENCLAW_TELEGRAM_CONFIRMATION_VERSION,
  registerTelegramConfirmationGateway,
  TELEGRAM_CONFIRMATION_NAMESPACE,
} from "../../dist/index.js";

const instant = "2026-08-19T01:00:00.000Z";
const expiresAt = "2026-08-19T03:00:00.000Z";
const messageReference = {
  schema_version: "cognitive-runtime.approval-message-reference/v2",
  provider: "telegram",
  instance_id: "instance-persistent",
  account_id: "account-private",
  conversation_id: "conversation-private",
  message_id: "42",
};

const createService = (store, now = () => new Date(instant)) => {
  let sequence = 0;
  return new CandidateAdmissionService({
    now,
    createId: (kind) => `${kind}-persistent-${++sequence}`,
    createRoutingToken: () => "persistent-routing-token-abcdefghijklmnopqrstuvwxyz1234567890",
    authorityHead: { getCurrent: () => null },
    persistence: store,
  });
};

const openConfirmation = (service) => {
  const authorization = service.authorizeDiscovery({
    instanceId: "instance-persistent",
    scope: { candidateTypes: ["semantic"], sourceRefs: ["src-private"] },
    grantedBy: "owner-private",
    expiresAt,
  });
  const candidate = service.createCandidate({
    authorizationId: authorization.authorization_id,
    candidateType: "semantic",
    stableId: "sem-persistent",
    baseAuthorityVersion: null,
    baseChecksum: null,
    baseContent: null,
    content: { claim: "A restart-safe claim." },
    sourceMap: [{ sourceRef: "src-private", contentPath: "body" }],
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

const operations = () => {
  const content = "---\nschema_version: cognitive-runtime.semantic/v2\nclaim_id: sem-persistent\n---\n";
  return [{
    operation: "write",
    path: "authority/semantic/sem-persistent.md",
    content,
    contentChecksum: calculatePublicationContentChecksum(content),
  }];
};

const createAuthority = () => {
  const state = { commit: null, commits: 0 };
  return {
    state,
    port: {
      async inspectCheckout() {
        return { kind: "dedicated", clean: true };
      },
      async validatePublication() {
        return {
          completeEntity: true,
          baseMatches: true,
          schemaValid: true,
          referencesValid: true,
          targetChecksumsValid: true,
          expectedTreeChecksum: `sha256:${"b".repeat(64)}`,
        };
      },
      async findCommit(changeSet) {
        return state.commit?.changeSetId === changeSet.change_set_id
          ? structuredClone(state.commit)
          : null;
      },
      async commitPublication({ changeSet, expectedTreeChecksum, metadata }) {
        assert.doesNotMatch(
          JSON.stringify(metadata),
          /owner-private|account-private|conversation-private/,
        );
        state.commits += 1;
        state.commit = {
          changeSetId: changeSet.change_set_id,
          changeSetChecksum: changeSet.checksum,
          commitId: "a".repeat(40),
          sourceRevision: "a".repeat(40),
          treeChecksum: expectedTreeChecksum,
        };
        return structuredClone(state.commit);
      },
    },
  };
};

test("Telegram acceptance survives restart and the same Receipt publishes once after interruption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stella-persistent-admission-"));
  const firstStore = new FileCandidateAdmissionStore({
    directory,
    now: () => new Date(instant),
  });
  const opened = openConfirmation(createService(firstStore));

  const admissionDirectory = join(directory, "candidate-admission");
  const databasePath = join(admissionDirectory, "admission.sqlite");
  assert.equal((await stat(admissionDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
  assert.match(await readFile(databasePath, "utf8"), /conversation-private/);

  const restartedStore = new FileCandidateAdmissionStore({
    directory,
    now: () => new Date(instant),
  });
  const restartedService = createService(restartedStore);
  const registrations = [];
  registerTelegramConfirmationGateway({
    api: { registerInteractiveHandler: (registration) => registrations.push(registration) },
    service: restartedService,
    hostVersion: OPENCLAW_TELEGRAM_CONFIRMATION_VERSION,
  });
  const replies = [];
  await registrations[0].handler({
    channel: "telegram",
    accountId: "account-private",
    conversationId: "conversation-private",
    senderId: "owner-private",
    auth: { isAuthorizedSender: true },
    callback: {
      namespace: TELEGRAM_CONFIRMATION_NAMESPACE,
      payload: `a:${opened.confirmation.routingToken}`,
      messageId: 42,
    },
    respond: {
      async clearButtons() { replies.push("cleared"); },
      async reply({ text }) { replies.push(text); },
    },
  });
  assert.deepEqual(replies, ["cleared", "AUTHORITY_CANDIDATE_ACCEPTED"]);

  const publicationStore = new FileCandidateAdmissionStore({
    directory,
    now: () => new Date(instant),
  });
  const approved = await publicationStore.loadApprovedCandidateRevision(
    opened.candidate.candidate_id,
    opened.candidate.revision,
  );
  assert.equal(approved.candidate.checksum, opened.candidate.checksum);
  const input = {
    candidate: approved.candidate,
    approvalReceipt: approved.receipt,
    operations: operations(),
  };
  const artifact = createChangeSet(input);
  const authority = createAuthority();
  let crash = true;
  const journal = new FilePublicationJournal({ directory });
  const crashing = new ChangeSetPublicationCoordinator({
    journal,
    authority: authority.port,
    approvals: publicationStore,
    failpoint(point) {
      if (crash && point === "before_authority_write") {
        crash = false;
        throw new Error("PROCESS_EXIT_BEFORE_AUTHORITY_WRITE");
      }
    },
  });
  await assert.rejects(
    () => crashing.publish(input),
    /PROCESS_EXIT_BEFORE_AUTHORITY_WRITE/,
  );
  createService(publicationStore).endDiscovery(opened.authorization.authorization_id);

  const recovered = await new ChangeSetPublicationCoordinator({
    journal: new FilePublicationJournal({ directory }),
    authority: authority.port,
    approvals: new FileCandidateAdmissionStore({
      directory,
      now: () => new Date("2026-08-19T04:00:00.000Z"),
    }),
  }).recover(artifact.changeSet.change_set_id);
  assert.equal(recovered.sourceRevision, "a".repeat(40));
  assert.equal(authority.state.commits, 1);
  await assert.rejects(
    () => publicationStore.loadApprovedCandidateRevision(
      opened.candidate.candidate_id,
      opened.candidate.revision,
    ),
    /APPROVAL_RECEIPT_INVALID/,
  );
  await assert.rejects(
    () => new ChangeSetPublicationCoordinator({
      journal: new FilePublicationJournal({ directory }),
      authority: authority.port,
      approvals: publicationStore,
    }).publish({
      ...input,
      operations: [{ ...operations()[0], path: "authority/semantic/other.md" }],
    }),
    /APPROVAL_RECEIPT_ALREADY_CONSUMED/,
  );
});

for (const crashPoint of ["after_git_commit", "before_receipt_finalization"]) {
  test(`persistent admission recovers exact publication from ${crashPoint}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `stella-persistent-${crashPoint}-`));
    const store = new FileCandidateAdmissionStore({
      directory,
      now: () => new Date(instant),
    });
    const opened = openConfirmation(createService(store));
    const decision = createService(store).decideConfirmation({
      routingToken: opened.confirmation.routingToken,
      action: "accept",
      authorized: true,
      senderId: "owner-private",
      messageReference,
    });
    assert.equal(decision.status, "decided");
    const approved = await store.loadApprovedCandidateRevision(
      opened.candidate.candidate_id,
      opened.candidate.revision,
    );
    const input = {
      candidate: approved.candidate,
      approvalReceipt: approved.receipt,
      operations: operations(),
    };
    const artifact = createChangeSet(input);
    const authority = createAuthority();
    let crash = true;
    await assert.rejects(
      () => new ChangeSetPublicationCoordinator({
        journal: new FilePublicationJournal({ directory }),
        authority: authority.port,
        approvals: store,
        failpoint(point) {
          if (crash && point === crashPoint) {
            crash = false;
            throw new Error(`PROCESS_EXIT:${crashPoint}`);
          }
        },
      }).publish(input),
      new RegExp(`PROCESS_EXIT:${crashPoint}`),
    );
    const recovered = await new ChangeSetPublicationCoordinator({
      journal: new FilePublicationJournal({ directory }),
      authority: authority.port,
      approvals: new FileCandidateAdmissionStore({
        directory,
        now: () => new Date("2026-08-19T04:00:00.000Z"),
      }),
    }).recover(artifact.changeSet.change_set_id);
    assert.equal(recovered.publicationStatus, "Published");
    assert.equal(authority.state.commits, 1);
  });
}

test("ended, rewritten, expired, and replayed confirmations remain invalid after restart", async () => {
  const endedDirectory = await mkdtemp(join(tmpdir(), "stella-persistent-ended-"));
  const endedStore = new FileCandidateAdmissionStore({
    directory: endedDirectory,
    now: () => new Date(instant),
  });
  const ended = openConfirmation(createService(endedStore));
  createService(endedStore).endDiscovery(ended.authorization.authorization_id);
  assert.throws(
    () => createService(new FileCandidateAdmissionStore({
      directory: endedDirectory,
      now: () => new Date(instant),
    })).decideConfirmation({
      routingToken: ended.confirmation.routingToken,
      action: "accept",
      authorized: true,
      senderId: "owner-private",
      messageReference,
    }),
    /CONFIRMATION_ROUTING_TOKEN_INVALID/,
  );

  const rewrittenDirectory = await mkdtemp(join(tmpdir(), "stella-persistent-rewritten-"));
  const rewrittenStore = new FileCandidateAdmissionStore({
    directory: rewrittenDirectory,
    now: () => new Date(instant),
  });
  const rewritten = openConfirmation(createService(rewrittenStore));
  createService(rewrittenStore).decideConfirmation({
    routingToken: rewritten.confirmation.routingToken,
    action: "accept",
    authorized: true,
    senderId: "owner-private",
    messageReference,
  });
  createService(rewrittenStore).reviseCandidate({
    authorizationId: rewritten.authorization.authorization_id,
    candidateId: rewritten.candidate.candidate_id,
    baseAuthorityVersion: null,
    baseChecksum: null,
    baseContent: null,
    content: { claim: "A replacement revision." },
    sourceMap: [{ sourceRef: "src-private", contentPath: "body" }],
  });
  await assert.rejects(
    () => new FileCandidateAdmissionStore({
      directory: rewrittenDirectory,
      now: () => new Date(instant),
    }).loadApprovedCandidateRevision(
      rewritten.candidate.candidate_id,
      rewritten.candidate.revision,
    ),
    /APPROVAL_RECEIPT_INVALID/,
  );

  const replayDirectory = await mkdtemp(join(tmpdir(), "stella-persistent-replay-"));
  const replayStore = new FileCandidateAdmissionStore({
    directory: replayDirectory,
    now: () => new Date(instant),
  });
  const replay = openConfirmation(createService(replayStore));
  const callback = {
    routingToken: replay.confirmation.routingToken,
    action: "accept",
    authorized: true,
    senderId: "owner-private",
    messageReference,
  };
  createService(replayStore).decideConfirmation(callback);
  assert.throws(
    () => createService(new FileCandidateAdmissionStore({
      directory: replayDirectory,
      now: () => new Date(instant),
    })).decideConfirmation(callback),
    /CONFIRMATION_ROUTING_TOKEN_INVALID/,
  );
  await assert.rejects(
    () => new FileCandidateAdmissionStore({
      directory: replayDirectory,
      now: () => new Date("2026-08-19T04:00:00.000Z"),
    }).loadApprovedCandidateRevision(replay.candidate.candidate_id, replay.candidate.revision),
    /APPROVAL_RECEIPT_INVALID/,
  );
});

test("concurrent persistent callbacks and publications admit one exact outcome", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stella-persistent-concurrent-"));
  const store = new FileCandidateAdmissionStore({
    directory,
    now: () => new Date(instant),
  });
  const opened = openConfirmation(createService(store));
  const callback = {
    routingToken: opened.confirmation.routingToken,
    action: "accept",
    authorized: true,
    senderId: "owner-private",
    messageReference,
  };
  const callbackOutcomes = await Promise.allSettled([
    Promise.resolve().then(() => createService(new FileCandidateAdmissionStore({
      directory,
      now: () => new Date(instant),
    })).decideConfirmation(callback)),
    Promise.resolve().then(() => createService(new FileCandidateAdmissionStore({
      directory,
      now: () => new Date(instant),
    })).decideConfirmation(callback)),
  ]);
  assert.equal(
    callbackOutcomes.filter((outcome) => outcome.status === "fulfilled").length,
    1,
  );
  assert.equal(
    callbackOutcomes.filter((outcome) => outcome.status === "rejected").length,
    1,
  );

  const approvals = new FileCandidateAdmissionStore({
    directory,
    now: () => new Date(instant),
  });
  const approved = await approvals.loadApprovedCandidateRevision(
    opened.candidate.candidate_id,
    opened.candidate.revision,
  );
  const authority = createAuthority();
  const createCoordinator = () => new ChangeSetPublicationCoordinator({
    journal: new FilePublicationJournal({ directory }),
    authority: authority.port,
    approvals: new FileCandidateAdmissionStore({
      directory,
      now: () => new Date(instant),
    }),
  });
  const firstOperations = operations();
  const secondOperations = [{
    ...firstOperations[0],
    path: "authority/semantic/other.md",
  }];
  const publicationOutcomes = await Promise.allSettled([
    createCoordinator().publish({
      candidate: approved.candidate,
      approvalReceipt: approved.receipt,
      operations: firstOperations,
    }),
    createCoordinator().publish({
      candidate: approved.candidate,
      approvalReceipt: approved.receipt,
      operations: secondOperations,
    }),
  ]);
  assert.equal(
    publicationOutcomes.filter((outcome) => outcome.status === "fulfilled").length,
    1,
  );
  assert.equal(
    publicationOutcomes.filter((outcome) => outcome.status === "rejected").length,
    1,
  );
  assert.equal(authority.state.commits, 1);
});
