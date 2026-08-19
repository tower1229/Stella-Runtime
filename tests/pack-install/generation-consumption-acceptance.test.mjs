import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  commitAuthorityChanges,
  commitSyntheticAuthority,
  writeSyntheticAuthority,
} from "../helpers/synthetic-authority.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL("../../", import.meta.url);
const checksum = (character) => `sha256:${character.repeat(64)}`;

async function installPackedRuntime(root) {
  const packRoot = join(root, "pack");
  const consumerRoot = join(root, "consumer");
  await Promise.all([mkdir(packRoot), mkdir(consumerRoot)]);
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packRoot],
    {
      cwd: repositoryRoot,
      env: { ...process.env, npm_config_cache: join(root, "npm-cache") },
    },
  );
  const [pack] = JSON.parse(stdout);
  assert.equal(pack.version, "0.2.0");
  await execFileAsync("tar", ["-xzf", join(packRoot, pack.filename), "-C", consumerRoot]);
  await symlink(new URL("../../node_modules", import.meta.url), join(consumerRoot, "node_modules"));
  const packageRoot = join(consumerRoot, "package");
  return {
    packageRoot,
    runtime: await import(pathToFileURL(join(packageRoot, "dist", "index.js")).href),
  };
}

function deterministicAdmission(runtime) {
  let sequence = 0;
  const service = new runtime.CandidateAdmissionService({
    now: () => new Date("2026-08-18T06:00:00.000Z"),
    createId: (kind) => `${kind}-packed-acceptance-${++sequence}`,
    createRoutingToken: () => `routing-${String(++sequence).padStart(64, "0")}`,
    authorityHead: { getCurrent: () => null },
  });
  const candidateInput = {
    candidateType: "semantic",
    stableId: "sem-packed-accepted",
    baseAuthorityVersion: null,
    baseChecksum: null,
    baseContent: null,
    content: { claim: "Packed approval reaches the next eligible Run." },
    sourceMap: [{ sourceRef: "src-synthetic-note", contentPath: "body" }],
  };
  assert.throws(
    () => service.createCandidate({ authorizationId: "ordinary-conversation", ...candidateInput }),
    /DISCOVERY_AUTHORIZATION_NOT_ACTIVE/,
  );
  const authorization = service.authorizeDiscovery({
    instanceId: "instance-packed-acceptance",
    scope: { candidateTypes: ["semantic"], sourceRefs: ["src-synthetic-note"] },
    grantedBy: "owner-packed-acceptance",
    expiresAt: "2026-08-18T07:00:00.000Z",
  });
  const candidate = service.createCandidate({
    authorizationId: authorization.authorization_id,
    ...candidateInput,
  });
  assert.deepEqual(service.prepareConfirmation({
    authorizationId: authorization.authorization_id,
    candidateId: candidate.candidate_id,
    revision: candidate.revision,
    channel: "webchat",
  }), { status: "redirect_required", confirmedChannel: "telegram" });
  const confirmation = service.prepareConfirmation({
    authorizationId: authorization.authorization_id,
    candidateId: candidate.candidate_id,
    revision: candidate.revision,
    channel: "telegram",
  });
  assert.equal(confirmation.status, "ready");
  const messageReference = {
    schema_version: "cognitive-runtime.approval-message-reference/v2",
    provider: "telegram",
    instance_id: "instance-packed-acceptance",
    account_id: "account-packed-acceptance",
    conversation_id: "conversation-packed-acceptance",
    message_id: "42",
  };
  service.bindConfirmationMessage({
    routingToken: confirmation.routingToken,
    messageReference,
  });
  const callback = {
    routingToken: confirmation.routingToken,
    authorized: true,
    senderId: "owner-packed-acceptance",
    messageReference,
  };
  assert.throws(
    () => service.decideConfirmation({ ...callback, action: "I approve" }),
    /CONFIRMATION_ACTION_UNSUPPORTED/,
  );
  const decision = service.decideConfirmation({ ...callback, action: "accept" });
  assert.equal(decision.status, "decided");
  assert.throws(() => service.consumeApprovalReceipt({
    receiptId: decision.receipt.receipt_id,
    candidateId: candidate.candidate_id,
    candidateRevision: candidate.revision,
    candidateChecksum: checksum("0"),
    baseAuthorityVersion: candidate.base_authority_version,
  }), /APPROVAL_RECEIPT_CANDIDATE_MISMATCH/);

  const ended = service.authorizeDiscovery({
    instanceId: "instance-packed-acceptance",
    scope: { candidateTypes: ["semantic"], sourceRefs: ["src-synthetic-note"] },
    grantedBy: "owner-packed-acceptance",
    expiresAt: "2026-08-18T07:00:00.000Z",
  });
  service.endDiscovery(ended.authorization_id);
  assert.throws(
    () => service.createCandidate({ authorizationId: ended.authorization_id, ...candidateInput }),
    /DISCOVERY_AUTHORIZATION_NOT_ACTIVE/,
  );
  return { candidate, approvalReceipt: decision.receipt };
}

async function publishCandidate(runtime, root, authorityDirectory, input) {
  const approvals = new runtime.FileApprovalPublicationStore({
    directory: join(root, "approval-records"),
  });
  await approvals.recordApproval({
    receipt: input.approvalReceipt,
    candidate: input.candidate,
  });
  const journal = new runtime.FilePublicationJournal({
    directory: join(root, "publication-journal"),
  });
  let commit = null;
  const expectedTreeChecksum = checksum("b");
  const authority = {
    async inspectCheckout() {
      const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
        cwd: authorityDirectory,
      });
      return { kind: "dedicated", clean: stdout.length === 0 };
    },
    async validatePublication() {
      return {
        completeEntity: true,
        baseMatches: true,
        schemaValid: true,
        referencesValid: true,
        targetChecksumsValid: true,
        expectedTreeChecksum,
      };
    },
    async findCommit(changeSet) {
      return commit?.changeSetId === changeSet.change_set_id ? commit : null;
    },
    async commitPublication({ changeSet, operations, metadata }) {
      for (const operation of operations) {
        assert.equal(operation.operation, "write");
        const path = join(authorityDirectory, operation.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, operation.content);
      }
      await execFileAsync("git", ["add", "."], { cwd: authorityDirectory });
      await execFileAsync("git", ["commit", "-m", metadata.subject], {
        cwd: authorityDirectory,
      });
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: authorityDirectory,
      });
      commit = {
        changeSetId: changeSet.change_set_id,
        changeSetChecksum: changeSet.checksum,
        commitId: stdout.trim(),
        sourceRevision: stdout.trim(),
        treeChecksum: expectedTreeChecksum,
      };
      return commit;
    },
  };
  const content = `---\nschema_version: cognitive-runtime.semantic/v2\nclaim_id: sem-packed-accepted\nrecord_type: fact\naliases: []\nscope: { contexts: [review], conditions: [] }\nvalid_time: { from: 2026-08-18, to: null }\nepistemic: user_explicit\nconfidence: high\nsource_refs: [src-synthetic-note]\nrelated_claims: []\nsupersedes: []\ncreated_at: 2026-08-18\nupdated_at: 2026-08-18\n---\nPacked approval reaches the next eligible Run.\n`;
  const coordinator = new runtime.ChangeSetPublicationCoordinator({
    journal,
    authority,
    approvals,
  });
  const result = await coordinator.publish({
    ...input,
    operations: [{
      operation: "write",
      path: "semantic/sem-packed-accepted/claim.md",
      content,
      contentChecksum: runtime.calculatePublicationContentChecksum(content),
    }],
  });
  assert.equal(result.publicationStatus, "Published");
  assert.equal(result.activationStatus, "Pending Activation");
  const { stdout } = await execFileAsync(
    "git",
    ["show", `${result.sourceRevision}:semantic/sem-packed-accepted/claim.md`],
    { cwd: authorityDirectory },
  );
  assert.match(stdout, /Packed approval reaches the next eligible Run/);
  return result.sourceRevision;
}

function runtimeConfig(root, authorityDirectory) {
  return {
    schema_version: "cognitive-runtime.instance-runtime-config/v2",
    instance_id: "instance-packed-acceptance",
    mode: "enforce",
    runtime_storage: join(root, "runtime-state"),
    generation_storage: join(root, "generation-state", "generations"),
    host: { agent_id: "main", eligible_scope: ["private_main_session"] },
    authority_owner: { provider: "telegram", actor_id: "owner-packed-acceptance" },
    limits: { max_active_runs: 4, drain_timeout_ms: 30_000 },
    adapters: {
      authority_checkout: authorityDirectory,
      host_retrieval: "openclaw-memory",
    },
  };
}

const evidenceFor = (target) => ({
  deepStatus: "pass",
  generationId: target.syncGeneration,
  sourceRevision: target.sourceRevision,
  projectionChecksum: target.projectionChecksum,
  hostConfigChecksum: target.hostConfigChecksum,
  searchSentinelChecksum: checksum("3"),
  getSentinelChecksum: checksum("4"),
});

test("packed Runtime proves approval through publication, recovery, and next-Run binding", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-packed-consumption-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { runtime } = await installPackedRuntime(root);
  const authorityDirectory = join(root, "authority-checkout");
  await writeSyntheticAuthority(authorityDirectory);
  await commitSyntheticAuthority(authorityDirectory);
  const admission = deterministicAdmission(runtime);
  const sourceRevision = await publishCandidate(
    runtime,
    root,
    authorityDirectory,
    admission,
  );
  const config = runtimeConfig(root, authorityDirectory);
  const state = runtime.createStateManagementPort({
    stateRoot: config.runtime_storage,
    instanceId: config.instance_id,
  });
  await state.initialize();
  state.close();
  let activeTarget = null;
  let failure = null;
  const host = {
    async capture() { return { activeTarget }; },
    async applyTarget(target) {
      activeTarget = target;
      if (failure?.phase === "apply") throw new Error(failure.code);
    },
    async verifyTarget(target) {
      if (failure?.phase === "verify") throw new Error(failure.code);
      return evidenceFor(target);
    },
    async restore(snapshot) { activeTarget = snapshot.activeTarget; },
    async verifyPrior(_snapshot, target) { return evidenceFor(target); },
  };
  let admissionClosed = false;
  const runs = {
    closeAdmission() { admissionClosed = true; },
    openAdmission() { admissionClosed = false; },
    async drain() {},
  };
  const activated = await runtime.syncGeneration({
    config,
    sourceRevision,
    packageVersion: "0.2.0",
    hostVersion: "2026.6.34",
    nodeVersion: "24.18.0",
    host,
    runs,
  });
  assert.equal(admissionClosed, false);
  const binding = await new runtime.FileBindingCompiler().compile({
    config,
    hostVersion: "2026.6.34",
    nodeVersion: "24.18.0",
  });
  assert.equal(binding.syncGeneration, activated.syncGeneration);
  assert.equal(binding.authorityRevision, sourceRevision);
  assert.ok(binding.context.semanticClaims.some((claim) =>
    claim.id === "sem-packed-accepted"
    && claim.content.includes("Packed approval reaches the next eligible Run.")),
  JSON.stringify(binding.context.semanticClaims));

  for (const scenario of [
    { phase: "apply", code: "HOST_CONFIG_MUTATION_FAILED" },
    { phase: "apply", code: "HOST_INDEX_FAILED" },
    { phase: "verify", code: "OPENCLAW_SEARCH_SENTINEL_MISSING" },
    { phase: "apply", code: "PROCESS_INTERRUPTED_AFTER_CONFIG_WRITE" },
  ]) {
    await writeFile(
      join(authorityDirectory, "acceptance-step.txt"),
      `${scenario.code}\n`,
    );
    const failedRevision = await commitAuthorityChanges(
      authorityDirectory,
      `acceptance: ${scenario.code}`,
    );
    failure = scenario;
    await assert.rejects(runtime.syncGeneration({
      config,
      sourceRevision: failedRevision,
      packageVersion: "0.2.0",
      hostVersion: "2026.6.34",
      nodeVersion: "24.18.0",
      host,
      runs,
    }), new RegExp(scenario.code));
    failure = null;
    assert.equal(admissionClosed, false);
    const recovered = await new runtime.FileBindingCompiler().compile({
      config,
      hostVersion: "2026.6.34",
      nodeVersion: "24.18.0",
    });
    assert.equal(recovered.syncGeneration, activated.syncGeneration);
    assert.equal(recovered.authorityRevision, sourceRevision);
  }

  const active = await runtime.loadActiveGenerationHealth(config);
  assert.deepEqual(runtime.validateActiveReceipt(
    { ...active, receipt: { ...active.receipt, generation_id: `generation-${"f".repeat(64)}` } },
    config,
    "2026.6.34",
    "24.18.0",
  ), { valid: false, reasonCodes: ["STALE_RECEIPT"] });
  assert.deepEqual(runtime.validateActiveReceipt(
    active,
    {
      ...config,
      adapters: { ...config.adapters, host_retrieval: "drifted-memory" },
    },
    "2026.6.34",
    "24.18.0",
  ), { valid: false, reasonCodes: ["CONFIG_DRIFT"] });

  const monitor = new runtime.RuntimeHealthMonitor({
    config,
    hostVersion: "2026.6.34",
    nodeVersion: "24.18.0",
    expectedHostVersion: "2026.6.34",
    expectedNodeVersions: ["24.18.0"],
    pluginDiscovered: () => true,
    hostCapabilities: () => true,
    authority: { validate: async () => ({ sourceRevision }) },
    configIdentity: { verify: async () => ({ valid: true, reasonCodes: [] }) },
    retrieval: { verify: async () => { throw new Error("INDEX_DRIFT"); } },
    active: { load: async () => active },
    now: () => "2026-08-18T06:30:00.000Z",
  });
  const reconciliation = await monitor.reconcile("detected_drift");
  assert.equal(reconciliation.status, "fail");
  assert.deepEqual(reconciliation.reasonCodes, ["INDEX_DRIFT"]);
  assert.deepEqual(await monitor.checkRunGate(), {
    allowed: false,
    reasonCodes: ["INDEX_DRIFT"],
  });
});
