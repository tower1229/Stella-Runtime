import { appendFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const evidencePath = process.env.STELLA_RUNTIME_PROBE_EVIDENCE;
const runtimeRoot = process.env.STELLA_RUNTIME_PROBE_ROOT;
const databasePath = process.env.STELLA_RUNTIME_PROBE_DATABASE;
const sessionKey = process.env.STELLA_RUNTIME_PROBE_SESSION_KEY;
const activeRuns = new Map();
const execFileAsync = promisify(execFile);
let savedRetrievalPaths;
const contractChecksum = (digit) => `sha256:${digit.repeat(64)}`;

function record(entry) {
  if (evidencePath === undefined) {
    throw new Error("STELLA_RUNTIME_PROBE_EVIDENCE_REQUIRED");
  }
  appendFileSync(evidencePath, `${JSON.stringify(entry)}\n`, "utf8");
}

function runKind(prompt) {
  if (prompt.includes("MEMORY_RUN")) {
    return "memory";
  }
  if (prompt.includes("ELIGIBLE_GENERATION_RUN")) {
    return "eligible_generation";
  }
  if (prompt.includes("PLAIN_RUN_RETRY")) {
    return "command_retry";
  }
  if (prompt.includes("PLAIN_RUN_ABORT")) {
    return "command_abort";
  }
  if (prompt.includes("PLAIN_RUN")) {
    return "plain";
  }
  return "other";
}

async function loadRuntime() {
  if (runtimeRoot === undefined) {
    throw new Error("STELLA_RUNTIME_PROBE_ROOT_REQUIRED");
  }
  return import(pathToFileURL(join(runtimeRoot, "dist", "index.js")).href);
}

const eligibleContext = (runId) => ({
  runId,
  sessionKey: "agent:main:telegram:direct:+15555550123",
  agentId: "main",
  trigger: "user",
  messageProvider: "telegram",
  senderId: "+15555550123",
  chatId: "+15555550123",
});

function acceptedRouterResult(binding) {
  const governing = binding.context.governing?.system;
  return {
    memory_route: "none",
    state_refs: binding.context.stateView.map((entry) => entry.id),
    governing: governing === null || governing === undefined ? null : {
      system: governing.id,
      kernel_version: governing.version,
      modules: (binding.context.governing?.modules ?? []).map((entry) => ({
        id: entry.id,
        version: entry.version,
      })),
    },
    frameworks: { primary: null, secondary: null },
    retrieval_plan: [],
    confidence: 1,
    reason_codes: ["PACKED_HOST_ACCEPTANCE"],
  };
}

async function runPackedFailClosedMatrix(config, hostApi) {
  const runtime = await loadRuntime();
  const hookRuntime = await import(
    pathToFileURL(join(runtimeRoot, "dist", "openclaw", "runtime.js")).href
  );
  const binding = await new runtime.FileBindingCompiler().compile({
    config,
    hostVersion: "2026.6.34",
    nodeVersion: process.versions.node,
  });
  const accepted = acceptedRouterResult(binding);

  const register = ({ complete, bindingCompiler, maxActiveRuns = 2 } = {}) => {
    const hooks = new Map();
    const controller = hookRuntime.registerRuntimeHooks({
      runtime: {
        version: "2026.6.34",
        llm: {
          complete: complete ?? (async () => ({ text: JSON.stringify(accepted) })),
        },
      },
      on(name, handler) { hooks.set(name, handler); },
      registerCli() {},
      logger: { info() {}, warn() {} },
    }, hookRuntime.readRuntimeConfig({
      runtime: {
        ...config,
        limits: { ...config.limits, max_active_runs: maxActiveRuns },
      },
    }), {
      bindingCompiler: bindingCompiler ?? { compile: async () => binding },
    });
    return { hooks, controller };
  };
  const executeHost = async (hooks, event, context) => {
    const gate = await hooks.get("before_agent_run")(event, context);
    if (gate?.outcome !== "block") {
      await hostApi.runtime.llm.complete({
        messages: [{ role: "user", content: "FINAL_HOST_MODEL" }],
        maxTokens: 8,
        temperature: 0,
        purpose: "cognitive-runtime.fail-closed-negative-control",
      });
    }
    return gate?.metadata?.reasonCode ?? "NOT_BLOCKED";
  };

  const missing = register();
  const missingRunId = await executeHost(
    missing.hooks,
    { prompt: "missing", messages: [] },
    eligibleContext(undefined),
  );

  const overflow = register();
  const inputLimit = await executeHost(
    overflow.hooks,
    { prompt: "x".repeat(16_001), messages: [] },
    eligibleContext("run-packed-input-limit"),
  );

  const invalid = register({ complete: async () => ({ text: "not-json" }) });
  const routerInvalid = await executeHost(
    invalid.hooks,
    { prompt: "invalid", messages: [] },
    eligibleContext("run-packed-router-invalid"),
  );

  const timedOut = register({ complete: async () => new Promise(() => {}) });
  const routerTimeout = await executeHost(
    timedOut.hooks,
    { prompt: "timeout", messages: [] },
    eligibleContext("run-packed-router-timeout"),
  );

  const capacity = register();
  await capacity.hooks.get("before_prompt_build")(
    { prompt: "first", messages: [] },
    eligibleContext("run-packed-capacity-first"),
  );
  const scratchCapacity = await executeHost(
    capacity.hooks,
    { prompt: "second", messages: [] },
    eligibleContext("run-packed-capacity-second"),
  );

  let releaseLifecycle;
  const lifecycle = register({
    complete: async () => {
      await new Promise((resolve) => { releaseLifecycle = resolve; });
      return { text: JSON.stringify(accepted) };
    },
  });
  const lifecyclePending = executeHost(
    lifecycle.hooks,
    { prompt: "lifecycle", messages: [] },
    eligibleContext("run-packed-lifecycle"),
  );
  while (releaseLifecycle === undefined) await new Promise((resolve) => setTimeout(resolve, 1));
  lifecycle.controller.clearLifecycle("restart");
  releaseLifecycle();
  const lifecycleInvalid = await lifecyclePending;

  const exception = register({
    bindingCompiler: { compile: async () => ({ ...binding, context: null }) },
  });
  const runtimeException = await executeHost(
    exception.hooks,
    { prompt: "exception", messages: [] },
    eligibleContext("run-packed-runtime-exception"),
  );

  return {
    missingRunId,
    inputLimit,
    routerInvalid,
    routerTimeout,
    scratchCapacity,
    lifecycleInvalid,
    runtimeException,
  };
}

async function runPackedAdmissionNegativeMatrix(config) {
  const runtime = await loadRuntime();
  const service = runtime.openClawCandidateAdmissionService;
  const { dispatchPluginInteractiveHandler } = await import(
    "openclaw/plugin-sdk/plugin-runtime"
  );
  const store = new runtime.FileCandidateAdmissionStore({
    directory: config.runtime_storage,
  });
  const headBefore = (await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: config.adapters.authority_checkout,
  })).stdout.trim();
  let sequence = 0;
  const candidateInput = (stableId) => ({
    candidateType: "semantic",
    stableId,
    baseAuthorityVersion: null,
    baseChecksum: null,
    baseContent: null,
    content: { claim: `Rejected packed admission ${stableId}.` },
    sourceMap: [{ sourceRef: "source-host-negative", contentPath: "body" }],
  });
  const createPresented = async (kind) => {
    sequence += 1;
    const instanceId = `instance-host-negative-${kind}-${sequence}`;
    const authorization = service.authorizeDiscovery({
      instanceId,
      scope: { candidateTypes: ["semantic"], sourceRefs: ["source-host-negative"] },
      grantedBy: "owner-host-negative",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const candidate = service.createCandidate({
      authorizationId: authorization.authorization_id,
      ...candidateInput(`sem-host-negative-${kind}-${sequence}`),
    });
    const presented = await runtime.presentTelegramConfirmation({
      service,
      input: {
        authorizationId: authorization.authorization_id,
        candidateId: candidate.candidate_id,
        revision: candidate.revision,
        channel: "telegram",
      },
      presentation: {
        async present() {
          return {
            schema_version: "cognitive-runtime.approval-message-reference/v2",
            provider: "telegram",
            instance_id: instanceId,
            account_id: "account-host-negative",
            conversation_id: "conversation-host-negative",
            message_id: String(100 + sequence),
          };
        },
      },
    });
    return { instanceId, authorization, candidate, presented };
  };
  const dispatch = async (callbackData, messageId) => dispatchPluginInteractiveHandler({
    channel: "telegram",
    data: callbackData,
    dedupeId: `host-negative-${sequence}-${messageId}`,
    invoke: (match) => match.registration.handler({
      channel: "telegram",
      accountId: "account-host-negative",
      conversationId: "conversation-host-negative",
      senderId: "owner-host-negative",
      auth: { isAuthorizedSender: true },
      callback: {
        namespace: match.namespace,
        payload: match.payload,
        messageId,
      },
      respond: { async clearButtons() {}, async reply() {} },
    }),
  });
  const rejectedReason = async (operation) => {
    try {
      await operation();
      return "NOT_REJECTED";
    } catch (error) {
      return error instanceof Error ? error.message.split(":", 1)[0] : String(error);
    }
  };

  const ordinary = await rejectedReason(() => service.createCandidate({
    authorizationId: "ordinary-conversation",
    ...candidateInput("sem-host-negative-ordinary"),
  }));

  const unsupported = service.authorizeDiscovery({
    instanceId: "instance-host-negative-unsupported",
    scope: { candidateTypes: ["semantic"], sourceRefs: ["source-host-negative"] },
    grantedBy: "owner-host-negative",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const unsupportedCandidate = service.createCandidate({
    authorizationId: unsupported.authorization_id,
    ...candidateInput("sem-host-negative-unsupported"),
  });
  const unsupportedResult = await runtime.presentTelegramConfirmation({
    service,
    input: {
      authorizationId: unsupported.authorization_id,
      candidateId: unsupportedCandidate.candidate_id,
      revision: unsupportedCandidate.revision,
      channel: "webchat",
    },
    presentation: { async present() { throw new Error("UNEXPECTED_PRESENTATION"); } },
  });

  const ended = await createPresented("ended");
  service.endDiscovery(ended.authorization.authorization_id);
  const endedReason = await rejectedReason(() => dispatch(
    ended.presented.actions?.[0]?.callbackData
      ?? `crad:a:${ended.presented.routingToken}`,
    100 + sequence,
  ));

  const llm = await createPresented("llm-text");
  const llmReason = await rejectedReason(() => dispatch(
    `crad:I approve:${llm.presented.routingToken}`,
    100 + sequence,
  ));

  let authorityCommits = 0;
  let changeSetPublications = 0;
  let mismatchedReceiptsUnconsumed = true;
  const mismatchReasons = {};
  for (const kind of ["checksum", "base", "revision"]) {
    const accepted = await createPresented(kind);
    await dispatch(`crad:a:${accepted.presented.routingToken}`, 100 + sequence);
    const [approved] = await store.listApprovedCandidateRevisions(accepted.instanceId);
    if (approved === undefined) throw new Error("NEGATIVE_APPROVAL_REQUIRED");
    const changedCandidate = kind === "checksum"
      ? { ...approved.candidate, checksum: contractChecksum("f") }
      : kind === "base"
        ? { ...approved.candidate, base_authority_version: "authority-version-drift" }
        : { ...approved.candidate, revision: approved.candidate.revision + 1 };
    const coordinator = new runtime.ChangeSetPublicationCoordinator({
      journal: new runtime.FilePublicationJournal({
        directory: join(config.runtime_storage, `negative-journal-${kind}-${sequence}`),
      }),
      authority: {
        async inspectCheckout() { return { kind: "dedicated", clean: true }; },
        async validatePublication() { throw new Error("UNEXPECTED_VALIDATION"); },
        async findCommit() { return null; },
        async commitPublication() { authorityCommits += 1; throw new Error("UNEXPECTED_COMMIT"); },
      },
      approvals: store,
    });
    const mismatchReason = await rejectedReason(async () => {
      await coordinator.publish({
      candidate: changedCandidate,
      approvalReceipt: approved.receipt,
      operations: [{
        operation: "write",
        path: `semantic/${changedCandidate.stable_id}/claim.md`,
        content: "must not publish\n",
        contentChecksum: runtime.calculatePublicationContentChecksum("must not publish\n"),
      }],
      });
      changeSetPublications += 1;
    });
    if (mismatchReason !== "PUBLICATION_APPROVAL_MISMATCH") {
      throw new Error(`NEGATIVE_PUBLICATION_REASON_INVALID:${kind}:${mismatchReason}`);
    }
    mismatchReasons[kind] = mismatchReason;
    mismatchedReceiptsUnconsumed &&= (
      await store.listApprovedCandidateRevisions(accepted.instanceId)
    ).length === 1;
  }
  const headAfter = (await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: config.adapters.authority_checkout,
  })).stdout.trim();
  const nonAcceptedReceiptCount = (
    await Promise.all([
      store.listApprovedCandidateRevisions("instance-host-negative-ended-1"),
      store.listApprovedCandidateRevisions("instance-host-negative-unsupported"),
      store.listApprovedCandidateRevisions("instance-host-negative-llm-text-2"),
    ])
  ).reduce((total, entries) => total + entries.length, 0);
  return {
    ordinary,
    ended: endedReason,
    unsupported: unsupportedResult.status,
    llmText: llmReason,
    nonAcceptedReceiptCount,
    authorityRevisionUnchanged: headAfter === headBefore,
    authorityCommits,
    changeSetPublications,
    mismatchReasons,
    mismatchedReceiptsUnconsumed,
  };
}

function readConfiguredRuntime(api) {
  const config = api.runtime.config.current();
  const runtimeConfig = config.plugins?.entries?.["cognitive-runtime"]?.config?.runtime;
  if (runtimeConfig === undefined) {
    throw new Error("STELLA_RUNTIME_PROBE_CONFIG_REQUIRED");
  }
  return runtimeConfig;
}

async function runConfirmationProbe() {
  const runtime = await loadRuntime();
  runtime.configureOpenClawCandidateAuthorityHead({
    getCurrent: () => null,
  });
  const service = runtime.openClawCandidateAdmissionService;
  const authorization = service.authorizeDiscovery({
    instanceId: "instance-host-probe",
    scope: {
      candidateTypes: ["semantic"],
      sourceRefs: ["source-host-probe"],
    },
    grantedBy: "owner-host-probe",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const candidate = service.createCandidate({
    authorizationId: authorization.authorization_id,
    candidateType: "semantic",
    stableId: "sem-packed-accepted",
    baseAuthorityVersion: null,
    baseChecksum: null,
    baseContent: null,
    content: { claim: "Packed approval reaches the next eligible Run." },
    sourceMap: [{ sourceRef: "source-host-probe", contentPath: "body" }],
  });
  let presented;
  await runtime.presentTelegramConfirmation({
    service,
    input: {
      authorizationId: authorization.authorization_id,
      candidateId: candidate.candidate_id,
      revision: candidate.revision,
      channel: "telegram",
    },
    presentation: {
      async present(input) {
        presented = input;
        return {
          schema_version: "cognitive-runtime.approval-message-reference/v2",
          provider: "telegram",
          instance_id: "instance-host-probe",
          account_id: "account-host-probe",
          conversation_id: "conversation-host-probe",
          message_id: "42",
        };
      },
    },
  });
  const [accept] = presented.actions;
  const { dispatchPluginInteractiveHandler } = await import(
    "openclaw/plugin-sdk/plugin-runtime"
  );
  const replies = [];
  const dispatch = await dispatchPluginInteractiveHandler({
    channel: "telegram",
    data: accept.callbackData,
    dedupeId: "host-probe-confirmation-42",
    invoke: (match) => match.registration.handler({
      channel: "telegram",
      accountId: "account-host-probe",
      conversationId: "conversation-host-probe",
      senderId: "owner-host-probe",
      auth: { isAuthorizedSender: true },
      callback: {
        namespace: match.namespace,
        payload: match.payload,
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
    }),
  });
  record({ hook: "gateway_start_confirmation", dispatch, replies });
}

async function publishAcceptedCandidate(runtime, config) {
  const authorityDirectory = config.adapters.authority_checkout;
  const approvals = new runtime.FileCandidateAdmissionStore({
    directory: config.runtime_storage,
  });
  const pending = await approvals.listApprovedCandidateRevisions(
    "instance-host-probe",
  );
  if (pending.length !== 1) throw new Error("ACCEPTED_CANDIDATE_REQUIRED");
  const [approved] = pending;
  const candidate = approved.candidate;
  const receipt = approved.receipt;
  const journal = new runtime.FilePublicationJournal({
    directory: join(config.runtime_storage, "publication-journal"),
  });
  let committed;
  const expectedTreeChecksum = contractChecksum("b");
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
      return committed?.changeSetId === changeSet.change_set_id ? committed : null;
    },
    async commitPublication({ changeSet, operations, metadata }) {
      for (const operation of operations) {
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
      committed = {
        changeSetId: changeSet.change_set_id,
        changeSetChecksum: changeSet.checksum,
        commitId: stdout.trim(),
        sourceRevision: stdout.trim(),
        treeChecksum: expectedTreeChecksum,
      };
      return committed;
    },
  };
  const content = `---\nschema_version: cognitive-runtime.semantic/v2\nclaim_id: sem-packed-accepted\nrecord_type: fact\naliases: []\nscope: { contexts: [review], conditions: [] }\nvalid_time: { from: 2026-08-18, to: null }\nepistemic: user_explicit\nconfidence: high\nsource_refs: [src-synthetic-note]\nrelated_claims: []\nsupersedes: []\ncreated_at: 2026-08-18\nupdated_at: 2026-08-18\n---\nPacked approval reaches the next eligible Run.\n`;
  const coordinator = new runtime.ChangeSetPublicationCoordinator({
    journal,
    authority,
    approvals,
  });
  return coordinator.publish({
    candidate,
    approvalReceipt: receipt,
    operations: [{
      operation: "write",
      path: "semantic/sem-packed-accepted/claim.md",
      content,
      contentChecksum: runtime.calculatePublicationContentChecksum(content),
    }],
  });
}

async function openStore() {
  if (runtimeRoot === undefined || databasePath === undefined) {
    throw new Error("STELLA_RUNTIME_PROBE_STORE_ENV_REQUIRED");
  }
  const state = await import(
    pathToFileURL(join(runtimeRoot, "dist", "state", "index.js")).href
  );
  return new state.SqliteReanswerStore({
    databasePath,
    initialHead: {
      active_seq: 0,
      view_version: "view-0",
      checksum: contractChecksum("0"),
      activated_at: "2026-08-11T00:00:00Z",
    },
  });
}

function correction(sequence, kind) {
  if (sessionKey === undefined) {
    throw new Error("STELLA_RUNTIME_PROBE_SESSION_KEY_REQUIRED");
  }
  return {
    event: {
      seq: sequence,
      event_id: `event-${kind}`,
      state_id: "state-synthetic",
      event_type: "correction",
      payload: { value: kind },
      observed_at: "2026-08-11T00:00:01Z",
      source_kind: "user_explicit",
      idempotency_key: `event-key-${kind}`,
      created_at: "2026-08-11T00:00:02Z",
    },
    outbox: {
      correctionId: `correction-${kind}`,
      instanceId: "instance-synthetic",
      sessionKeyHash: `sha256:${createHash("sha256").update(sessionKey).digest("hex")}`,
      priorRunId: `run-prior-${sequence}`,
      idempotencyKey: `outbox-key-${kind}`,
      createdAt: "2026-08-11T00:00:03Z",
    },
  };
}

const plugin = {
  id: "cognitive-runtime-host-probe",
  name: "Cognitive Runtime Synthetic Host Probe",
  description: "Synthetic exact-host probe for Stella Runtime pack-install tests",
  register(api) {
    api.registerGatewayMethod(
      "cognitive-probe.publish-accepted",
      async ({ respond }) => {
        try {
          const runtime = await loadRuntime();
          const config = readConfiguredRuntime(api);
          respond(true, await publishAcceptedCandidate(runtime, config));
        } catch (error) {
          respond(false, undefined, {
            code: "CANDIDATE_PUBLICATION_FAILED",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
      { scope: "operator.admin" },
    );
    api.registerGatewayMethod(
      "cognitive-probe.fail-closed-matrix",
      async ({ respond }) => {
        try {
          respond(true, await runPackedFailClosedMatrix(readConfiguredRuntime(api), api));
        } catch (error) {
          respond(false, undefined, {
            code: "FAIL_CLOSED_MATRIX_FAILED",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
      { scope: "operator.admin" },
    );
    api.registerGatewayMethod(
      "cognitive-probe.admission-negative-matrix",
      async ({ respond }) => {
        try {
          respond(true, await runPackedAdmissionNegativeMatrix(readConfiguredRuntime(api)));
        } catch (error) {
          respond(false, undefined, {
            code: "ADMISSION_NEGATIVE_MATRIX_FAILED",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
      { scope: "operator.admin" },
    );
    api.registerGatewayMethod(
      "cognitive-probe.remove-retrieval-paths",
      async ({ respond }) => {
        try {
          await api.runtime.config.mutateConfigFile({
            afterWrite: { mode: "auto" },
            mutate(draft) {
              const agent = draft.agents?.list?.find((entry) => entry.id === "main");
              if (agent?.memorySearch === undefined) {
                throw new Error("HOST_RETRIEVAL_CONFIG_REQUIRED");
              }
              savedRetrievalPaths = [...(agent.memorySearch.extraPaths ?? [])];
              agent.memorySearch.extraPaths = [];
            },
          });
          respond(true, { removed: true });
        } catch (error) {
          respond(false, undefined, {
            code: "HOST_RETRIEVAL_MUTATION_FAILED",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
      { scope: "operator.admin" },
    );
    api.registerGatewayMethod(
      "cognitive-probe.restore-retrieval-paths",
      async ({ respond }) => {
        try {
          if (savedRetrievalPaths === undefined) {
            throw new Error("HOST_RETRIEVAL_SNAPSHOT_REQUIRED");
          }
          await api.runtime.config.mutateConfigFile({
            afterWrite: { mode: "auto" },
            mutate(draft) {
              const agent = draft.agents?.list?.find((entry) => entry.id === "main");
              if (agent?.memorySearch === undefined) {
                throw new Error("HOST_RETRIEVAL_CONFIG_REQUIRED");
              }
              agent.memorySearch.extraPaths = [...savedRetrievalPaths];
            },
          });
          savedRetrievalPaths = undefined;
          respond(true, { restored: true });
        } catch (error) {
          respond(false, undefined, {
            code: "HOST_RETRIEVAL_RESTORE_FAILED",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
      { scope: "operator.admin" },
    );
    api.on("gateway_start", runConfirmationProbe);
    api.on("before_prompt_build", async (event, context) => {
      const kind = runKind(event.prompt);
      if (context.runId === undefined || kind === "other") {
        return;
      }
      if (kind === "eligible_generation") {
        context.senderId ??= "+15555550123";
        context.chatId ??= "+15555550123";
        record({
          hook: "eligible_generation_run",
          runId: context.runId,
          sessionKey: context.sessionKey,
          agentId: context.agentId,
          trigger: context.trigger,
          messageProvider: context.messageProvider,
          senderId: context.senderId,
          chatId: context.chatId,
        });
        return;
      }
      if (activeRuns.has(context.runId)) {
        return;
      }
      const nestedCompletion = await api.runtime.llm.complete({
        messages: [{ role: "user", content: "ROUTER_VALID" }],
        maxTokens: 512,
        temperature: 0,
        purpose: "cognitive-runtime.synthetic-hook-completion-probe",
      });
      const correctionId = kind === "memory"
        ? "correction-ui"
        : "correction-command";
      const deliveryMode = kind === "memory"
        ? "ui_normal_rpc"
        : "command_continuation";
      const store = await openStore();
      const claim = await store.claim(correctionId, {
        successorRunId: context.runId,
        deliveryMode,
      });
      const outbox = store.get(correctionId);
      store.close();
      if (claim === null || outbox === null) {
        throw new Error(`SYNTHETIC_REANSWER_CLAIM_FAILED:${correctionId}`);
      }
      activeRuns.set(context.runId, { claim, kind });
      record({
        hook: "before_prompt_build",
        runId: context.runId,
        sessionKey: context.sessionKey,
        runKind: kind,
        claimAttempt: claim.attempt,
        newViewVersion: outbox.new_view_version,
        nestedCompletionTextLength: nestedCompletion.text.length,
        nestedCompletionKeys: Object.keys(nestedCompletion).sort(),
      });
      return { prependContext: "[synthetic_probe_injection]" };
    }, { priority: 100 });
    api.on("after_tool_call", (event, context) => {
      record({
        hook: "after_tool_call",
        runId: event.runId ?? context.runId,
        sessionKey: context.sessionKey,
        toolName: event.toolName,
        toolCallId: event.toolCallId ?? context.toolCallId,
        result: event.result,
      });
    });
    api.on("before_agent_finalize", (event, context) => {
      record({
        hook: "before_agent_finalize",
        runId: event.runId ?? context.runId,
        sessionKey: event.sessionKey ?? context.sessionKey,
      });
    });
    api.on("agent_end", async (event, context) => {
      const runId = event.runId ?? context.runId;
      const active = runId === undefined ? undefined : activeRuns.get(runId);
      let outbox;
      let disposition;
      if (active !== undefined) {
        const store = await openStore();
        if (active.kind === "command_abort" || !event.success) {
          await store.release(active.claim, "HOST_ABORTED");
          disposition = "released";
        } else {
          await store.complete(active.claim);
          disposition = "completed";
        }
        outbox = store.get(active.claim.correctionId);
        store.close();
        activeRuns.delete(runId);
      }
      record({
        hook: "agent_end",
        runId,
        sessionKey: context.sessionKey,
        success: event.success,
        disposition,
        activeRunCount: activeRuns.size,
        outbox,
      });
    });

    api.registerTool({
      name: "synthetic_memory",
      label: "Synthetic memory",
      description: "Return stable synthetic memory references for host smoke",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      async execute() {
        return {
          content: [
            {
              type: "text",
              text: "Synthetic memory result",
              stable_refs: ["sem-synthetic"],
            },
          ],
          details: {
            results: [{ source_id: "src-synthetic" }],
          },
        };
      },
    });

    api.registerCli(
      ({ program }) => {
        const root = program
          .command("cognitive-probe")
          .description("Run synthetic cognitive host probes");
        root.command("router")
          .description("Exercise StrictRouter through host llm.complete")
          .action(async () => {
            const runtime = await loadRuntime();
            const entries = [];
            const registryChecksum = runtime.calculateRegistryChecksum(entries);
            const route = async (currentMessage) => {
              const router = new runtime.StrictRouter({
                complete: async (prompt) => {
                  const completion = await api.runtime.llm.complete({
                    messages: [{ role: "user", content: prompt }],
                    maxTokens: 512,
                    temperature: 0,
                    purpose: "cognitive-runtime.synthetic-host-probe",
                  });
                  return completion.text;
                },
              });
              return router.route({
                currentMessage,
                recentContext: [],
                stateViewVersion: "view-synthetic",
                activeGoverningSystem: null,
                syncGeneration: "generation-synthetic",
                expectedRegistryChecksum: registryChecksum,
                registry: { checksum: registryChecksum, entries },
              });
            };
            console.log(JSON.stringify({
              valid: await route("ROUTER_VALID"),
              invalid: await route("ROUTER_INVALID"),
              generic: await route("GENERIC_ROUTER"),
            }));
          });
        root.command("seed")
          .argument("<kind>")
          .action(async (kind) => {
            if (kind !== "command" && kind !== "ui") {
              throw new Error(`SYNTHETIC_CORRECTION_KIND_INVALID:${kind}`);
            }
            const store = await openStore();
            const result = await store.correct(
              correction(kind === "command" ? 1 : 2, kind),
            );
            store.close();
            console.log(JSON.stringify(result));
          });
        root.command("inspect")
          .action(async () => {
            const store = await openStore();
            const result = {
              command: store.get("correction-command"),
              ui: store.get("correction-ui"),
              head: store.getHead(),
              eventCount: store.getEventCount(),
            };
            store.close();
            console.log(JSON.stringify(result));
          });
      },
      {
        descriptors: [
          {
            name: "cognitive-probe",
            description: "Run synthetic cognitive host probes",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
};

export default plugin;
