import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  calculatePublicationContentChecksum,
  ChangeSetPublicationCoordinator,
  createChangeSet,
  FileApprovalPublicationStore,
  FilePublicationJournal,
} from "../../dist/index.js";

const candidate = {
  schema_version: "cognitive-runtime.authority-candidate/v2",
  candidate_id: "candidate-synthetic",
  revision: 1,
  candidate_type: "semantic",
  stable_id: "sem-synthetic",
  base_authority_version: null,
  base_checksum: null,
  content: { claim: "A bounded claim." },
  source_map: [{ source_ref: "src-synthetic", content_path: "body" }],
  exact_diff: "base:null\ncandidate:{\"claim\":\"A bounded claim.\"}",
  checksum: `sha256:${"1".repeat(64)}`,
  created_at: "2026-08-17T01:00:00.000Z",
};

const approvalReceipt = {
  schema_version: "cognitive-runtime.decision-receipt/v2",
  receipt_id: "receipt-synthetic",
  request_id: "request-synthetic",
  candidate_id: candidate.candidate_id,
  candidate_revision: candidate.revision,
  candidate_checksum: candidate.checksum,
  base_authority_version: null,
  decision: "accepted",
  decided_by: "owner-synthetic",
  message_reference: {
    provider: "telegram",
    instance_id: "instance-synthetic",
    account_id: "account-private",
    conversation_id: "conversation-private",
    message_id: "42",
  },
  decided_at: "2026-08-17T01:05:00.000Z",
  single_use: true,
};

test("one approved Candidate Revision deterministically becomes one immutable complete Change Set", () => {
  const content = "---\nschema_version: cognitive-runtime.semantic/v2\nclaim_id: sem-synthetic\n---\n";
  const operations = [{
    operation: "write",
    path: "authority/semantic/sem-synthetic.md",
    content,
    contentChecksum: calculatePublicationContentChecksum(content),
  }];

  const first = createChangeSet({ candidate, approvalReceipt, operations });
  const second = createChangeSet({
    candidate: structuredClone(candidate),
    approvalReceipt: structuredClone(approvalReceipt),
    operations: structuredClone(operations),
  });

  assert.deepEqual(second.changeSet, first.changeSet);
  assert.deepEqual(second.operations, first.operations);
  assert.match(first.changeSet.change_set_id, /^change-set-[a-f0-9]{64}$/);
  assert.equal(first.changeSet.operations.length, 1);
  assert.equal(Object.isFrozen(first.changeSet), true);
  assert.equal(Object.isFrozen(first.operations[0]), true);
  assert.throws(() => {
    first.operations[0].path = "authority/semantic/other.md";
  }, TypeError);

  assert.throws(
    () => createChangeSet({
      candidate,
      approvalReceipt: { ...approvalReceipt, candidate_checksum: `sha256:${"2".repeat(64)}` },
      operations,
    }),
    /PUBLICATION_APPROVAL_MISMATCH/,
  );
  assert.throws(
    () => createChangeSet({ candidate, approvalReceipt, operations: [] }),
    /PUBLICATION_OPERATIONS_EMPTY/,
  );
  assert.throws(
    () => createChangeSet({
      candidate,
      approvalReceipt,
      operations: [operations[0], { ...operations[0] }],
    }),
    /PUBLICATION_OPERATION_DUPLICATE_PATH/,
  );
  assert.throws(
    () => createChangeSet({
      candidate,
      approvalReceipt,
      operations: [{ ...operations[0], content: `${content}tampered` }],
    }),
    /PUBLICATION_CONTENT_CHECKSUM_MISMATCH/,
  );
});

const publicationOperations = () => {
  const content = "---\nschema_version: cognitive-runtime.semantic/v2\nclaim_id: sem-synthetic\n---\n";
  return [{
    operation: "write",
    path: "authority/semantic/sem-synthetic.md",
    content,
    contentChecksum: calculatePublicationContentChecksum(content),
  }];
};

const createPorts = () => {
  const state = {
    commit: null,
    commits: 0,
    finalized: null,
    validations: 0,
    commitMetadata: null,
    checkout: { kind: "dedicated", clean: true },
    validationError: null,
    validationEvidence: {
      completeEntity: true,
      baseMatches: true,
      schemaValid: true,
      referencesValid: true,
      targetChecksumsValid: true,
      expectedTreeChecksum: `sha256:${"b".repeat(64)}`,
    },
    commitTreeChecksum: null,
  };
  return {
    state,
    authority: {
      async inspectCheckout() {
        return state.checkout;
      },
      async validatePublication({ changeSet, candidate: exactCandidate, operations }) {
        state.validations += 1;
        if (state.validationError !== null) throw new Error(state.validationError);
        assert.equal(changeSet.base_checksum, exactCandidate.base_checksum);
        assert.equal(changeSet.operations[0].content_checksum, operations[0].contentChecksum);
        assert.deepEqual(exactCandidate.source_map, candidate.source_map);
        return structuredClone(state.validationEvidence);
      },
      async findCommit(changeSet) {
        return state.commit?.changeSetId === changeSet.change_set_id
          ? structuredClone(state.commit)
          : null;
      },
      async commitPublication({ changeSet, expectedTreeChecksum, metadata }) {
        state.commits += 1;
        state.commitMetadata = structuredClone(metadata);
        state.commit = {
          changeSetId: changeSet.change_set_id,
          changeSetChecksum: changeSet.checksum,
          commitId: "a".repeat(40),
          sourceRevision: "a".repeat(40),
          treeChecksum: state.commitTreeChecksum ?? expectedTreeChecksum,
        };
        return structuredClone(state.commit);
      },
    },
  };
};

test("publication requires a dedicated clean checkout and successful consumer validation before write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stella-publication-gates-"));
  const approvalsDirectory = await mkdtemp(join(tmpdir(), "stella-publication-gate-approvals-"));
  const ports = createPorts();
  const approvals = new FileApprovalPublicationStore({ directory: approvalsDirectory });
  await approvals.recordApproval({ receipt: approvalReceipt, candidate });
  const service = new ChangeSetPublicationCoordinator({
    journal: new FilePublicationJournal({ directory }),
    authority: ports.authority,
    approvals,
  });
  const input = { candidate, approvalReceipt, operations: publicationOperations() };

  ports.state.checkout = { kind: "workspace", clean: true };
  await assert.rejects(() => service.publish(input), /AUTHORITY_CHECKOUT_NOT_DEDICATED/);
  ports.state.checkout = { kind: "dedicated", clean: false };
  await assert.rejects(() => service.publish(input), /AUTHORITY_CHECKOUT_DIRTY/);
  ports.state.checkout = { kind: "dedicated", clean: true };
  ports.state.validationError = "AUTHORITY_BASE_DRIFT";
  await assert.rejects(() => service.publish(input), /AUTHORITY_BASE_DRIFT/);
  ports.state.validationError = null;
  ports.state.validationEvidence = {
    ...ports.state.validationEvidence,
    referencesValid: false,
  };
  await assert.rejects(
    () => service.publish(input),
    /PUBLICATION_VALIDATION_INCOMPLETE/,
  );
  assert.equal(ports.state.commits, 0);
});

for (const crashPoint of [
  "before_authority_write",
  "after_git_commit",
  "before_receipt_finalization",
]) {
  test(`publication recovers idempotently from ${crashPoint}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `stella-publication-${crashPoint}-`));
    const approvalsDirectory = await mkdtemp(join(tmpdir(), `stella-approval-${crashPoint}-`));
    const ports = createPorts();
    const approvals = new FileApprovalPublicationStore({ directory: approvalsDirectory });
    await approvals.recordApproval({ receipt: approvalReceipt, candidate });
    let shouldCrash = true;
    const journal = new FilePublicationJournal({ directory });
    const crashing = new ChangeSetPublicationCoordinator({
      journal,
      authority: ports.authority,
      approvals,
      failpoint(point) {
        if (shouldCrash && point === crashPoint) {
          shouldCrash = false;
          throw new Error(`CRASH:${point}`);
        }
      },
    });
    const input = { candidate, approvalReceipt, operations: publicationOperations() };
    const artifact = createChangeSet(input);

    await assert.rejects(() => crashing.publish(input), new RegExp(`CRASH:${crashPoint}`));
    if (crashPoint !== "before_authority_write") {
      ports.state.validationError = "AUTHORITY_BASE_DRIFT_AFTER_EXACT_COMMIT";
    }

    const recovered = await new ChangeSetPublicationCoordinator({
      journal: new FilePublicationJournal({ directory }),
      authority: ports.authority,
      approvals: new FileApprovalPublicationStore({ directory: approvalsDirectory }),
    }).recover(artifact.changeSet.change_set_id);

    assert.deepEqual(recovered, {
      changeSetId: artifact.changeSet.change_set_id,
      sourceRevision: "a".repeat(40),
      publicationStatus: "Published",
      activationStatus: "Pending Activation",
    });
    assert.equal(ports.state.commits, 1);
    assert.equal(
      (await approvals.loadPreparedPublication(artifact.changeSet.change_set_id)).finalization.changeSetId,
      artifact.changeSet.change_set_id,
    );
    assert.doesNotMatch(JSON.stringify(ports.state.commitMetadata), /account-private|conversation-private|owner-synthetic/);

    const receiptPath = join(
      directory,
      "publication-journal",
      `${artifact.changeSet.change_set_id}.json`,
    );
    assert.equal((await stat(receiptPath)).mode & 0o777, 0o600);
    const stored = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(stored.status, "completed");
    assert.equal(stored.commit.commitId, "a".repeat(40));
    assert.doesNotMatch(JSON.stringify(stored), /conversation-private|A bounded claim/);
  });
}

test("a completed publication is an exact no-op and cannot resolve to a different commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stella-publication-idempotent-"));
  const approvalsDirectory = await mkdtemp(join(tmpdir(), "stella-publication-idempotent-approvals-"));
  const ports = createPorts();
  const approvals = new FileApprovalPublicationStore({ directory: approvalsDirectory });
  await approvals.recordApproval({ receipt: approvalReceipt, candidate });
  const service = new ChangeSetPublicationCoordinator({
    journal: new FilePublicationJournal({ directory }),
    authority: ports.authority,
    approvals,
  });
  const input = { candidate, approvalReceipt, operations: publicationOperations() };

  const first = await service.publish(input);
  ports.state.validationError = "AUTHORITY_BASE_DRIFT_AFTER_EXACT_COMMIT";
  const second = await service.publish(input);
  assert.deepEqual(second, first);
  assert.equal(ports.state.commits, 1);

  ports.state.commit = { ...ports.state.commit, commitId: "c".repeat(40), sourceRevision: "c".repeat(40) };
  await assert.rejects(
    () => new ChangeSetPublicationCoordinator({
      journal: new FilePublicationJournal({ directory }),
      authority: ports.authority,
      approvals,
    }).recover(createChangeSet(input).changeSet.change_set_id),
    /PUBLICATION_COMMIT_MISMATCH/,
  );
});

test("protected Approval Receipt storage durably validates and consumes only the exact publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stella-approval-receipts-"));
  const store = new FileApprovalPublicationStore({ directory });
  await store.recordApproval({ receipt: approvalReceipt, candidate });

  const receiptPath = join(
    directory,
    "approval-records",
    `${approvalReceipt.receipt_id}.json`,
  );
  assert.equal((await stat(receiptPath)).mode & 0o777, 0o600);
  assert.match(await readFile(receiptPath, "utf8"), /conversation-private/);
  const artifact = createChangeSet({
    candidate,
    approvalReceipt,
    operations: publicationOperations(),
  });
  await store.preparePublication({ receipt: approvalReceipt, candidate, artifact });
  await assert.rejects(
    () => store.preparePublication({
      receipt: approvalReceipt,
      candidate,
      artifact: createChangeSet({
        candidate,
        approvalReceipt,
        operations: [{
          ...publicationOperations()[0],
          path: "authority/semantic/other.md",
        }],
      }),
    }),
    /APPROVAL_RECEIPT_ALREADY_PREPARED/,
  );
  const finalization = {
    receiptId: approvalReceipt.receipt_id,
    candidateId: candidate.candidate_id,
    candidateRevision: candidate.revision,
    candidateChecksum: candidate.checksum,
    changeSetId: artifact.changeSet.change_set_id,
    changeSetChecksum: artifact.changeSet.checksum,
    sourceRevision: "d".repeat(40),
  };
  await store.finalizePublication(finalization);

  const reopened = new FileApprovalPublicationStore({ directory });
  assert.deepEqual(
    (await reopened.loadPreparedPublication(finalization.changeSetId)).finalization,
    finalization,
  );
  await reopened.finalizePublication(finalization);
  await assert.rejects(
    () => reopened.finalizePublication({
      ...finalization,
      changeSetId: `change-set-${"e".repeat(64)}`,
    }),
    /APPROVAL_RECEIPT_ALREADY_CONSUMED/,
  );
});

test("concurrent exact retries serialize to one commit and one Receipt consumption", async () => {
  const journalDirectory = await mkdtemp(join(tmpdir(), "stella-publication-concurrent-journal-"));
  const approvalsDirectory = await mkdtemp(join(tmpdir(), "stella-publication-concurrent-approvals-"));
  const approvals = new FileApprovalPublicationStore({ directory: approvalsDirectory });
  await approvals.recordApproval({ receipt: approvalReceipt, candidate });
  const ports = createPorts();
  const createCoordinator = () => new ChangeSetPublicationCoordinator({
    journal: new FilePublicationJournal({ directory: journalDirectory }),
    authority: ports.authority,
    approvals: new FileApprovalPublicationStore({ directory: approvalsDirectory }),
  });
  const input = { candidate, approvalReceipt, operations: publicationOperations() };

  const [first, second] = await Promise.all([
    createCoordinator().publish(input),
    createCoordinator().publish(input),
  ]);

  assert.deepEqual(second, first);
  assert.equal(ports.state.commits, 1);
});

test("one Approval Receipt cannot concurrently bind two different Change Sets", async () => {
  const journalDirectory = await mkdtemp(join(tmpdir(), "stella-publication-race-journal-"));
  const approvalsDirectory = await mkdtemp(join(tmpdir(), "stella-publication-race-approvals-"));
  const approvals = new FileApprovalPublicationStore({ directory: approvalsDirectory });
  await approvals.recordApproval({ receipt: approvalReceipt, candidate });
  const ports = createPorts();
  const createCoordinator = () => new ChangeSetPublicationCoordinator({
    journal: new FilePublicationJournal({ directory: journalDirectory }),
    authority: ports.authority,
    approvals: new FileApprovalPublicationStore({ directory: approvalsDirectory }),
  });
  const firstOperations = publicationOperations();
  const secondOperations = [{
    ...firstOperations[0],
    path: "authority/semantic/other.md",
  }];

  const outcomes = await Promise.allSettled([
    createCoordinator().publish({ candidate, approvalReceipt, operations: firstOperations }),
    createCoordinator().publish({ candidate, approvalReceipt, operations: secondOperations }),
  ]);

  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  assert.match(
    outcomes.find((outcome) => outcome.status === "rejected").reason.message,
    /APPROVAL_RECEIPT_ALREADY_(?:PREPARED|CONSUMED)/,
  );
  assert.equal(ports.state.commits, 1);
});

test("publication refuses a commit whose Authority tree differs from the validated target", async () => {
  const journalDirectory = await mkdtemp(join(tmpdir(), "stella-publication-tree-journal-"));
  const approvalsDirectory = await mkdtemp(join(tmpdir(), "stella-publication-tree-approvals-"));
  const approvals = new FileApprovalPublicationStore({ directory: approvalsDirectory });
  await approvals.recordApproval({ receipt: approvalReceipt, candidate });
  const ports = createPorts();
  ports.state.commitTreeChecksum = `sha256:${"f".repeat(64)}`;
  const service = new ChangeSetPublicationCoordinator({
    journal: new FilePublicationJournal({ directory: journalDirectory }),
    authority: ports.authority,
    approvals,
  });

  await assert.rejects(
    () => service.publish({ candidate, approvalReceipt, operations: publicationOperations() }),
    /PUBLICATION_COMMIT_MISMATCH/,
  );
  const artifact = createChangeSet({
    candidate,
    approvalReceipt,
    operations: publicationOperations(),
  });
  assert.equal(
    (await approvals.loadPreparedPublication(artifact.changeSet.change_set_id)).finalization,
    null,
  );
});

test("a crashed process releases the journal lease and independent recoverers remain serialized", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stella-publication-process-lock-"));
  const changeSetId = `change-set-${"9".repeat(64)}`;
  const moduleUrl = new URL("../../dist/index.js", import.meta.url).href;
  const spawnScript = (script) => spawn(
    process.execPath,
    ["--input-type=module", "-e", script],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const collect = (child) => new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  const crasher = spawnScript(`
    import { FilePublicationJournal } from ${JSON.stringify(moduleUrl)};
    const journal = new FilePublicationJournal({ directory: ${JSON.stringify(directory)} });
    await journal.runExclusive(${JSON.stringify(changeSetId)}, async () => {
      console.log("locked");
      setTimeout(() => process.exit(19), 100);
      await new Promise(() => {});
    });
  `);
  await new Promise((resolve, reject) => {
    crasher.once("error", reject);
    crasher.stdout.on("data", (chunk) => {
      if (String(chunk).includes("locked")) resolve();
    });
  });
  const contenderScript = `
    import { FilePublicationJournal } from ${JSON.stringify(moduleUrl)};
    const journal = new FilePublicationJournal({ directory: ${JSON.stringify(directory)} });
    await journal.runExclusive(${JSON.stringify(changeSetId)}, async () => {
      const entered = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 80));
      console.log(JSON.stringify({ entered, left: Date.now() }));
    });
  `;
  const first = spawnScript(contenderScript);
  const second = spawnScript(contenderScript);
  const [crashed, firstResult, secondResult] = await Promise.all([
    collect(crasher),
    collect(first),
    collect(second),
  ]);

  assert.equal(crashed.code, 19, crashed.stderr);
  assert.equal(firstResult.code, 0, firstResult.stderr);
  assert.equal(secondResult.code, 0, secondResult.stderr);
  const firstInterval = JSON.parse(firstResult.stdout.trim());
  const secondInterval = JSON.parse(secondResult.stdout.trim());
  assert.equal(
    firstInterval.left <= secondInterval.entered ||
      secondInterval.left <= firstInterval.entered,
    true,
  );
});

test("Journal and protected Approval records may share one Runtime storage directory", {
  timeout: 2_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "stella-publication-shared-storage-"));
  const approvals = new FileApprovalPublicationStore({ directory });
  await approvals.recordApproval({ receipt: approvalReceipt, candidate });
  const ports = createPorts();
  const result = await new ChangeSetPublicationCoordinator({
    journal: new FilePublicationJournal({ directory }),
    authority: ports.authority,
    approvals,
  }).publish({ candidate, approvalReceipt, operations: publicationOperations() });

  assert.equal(result.publicationStatus, "Published");
  assert.equal(ports.state.commits, 1);
});
