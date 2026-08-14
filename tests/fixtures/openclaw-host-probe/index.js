import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const evidencePath = process.env.STELLA_RUNTIME_PROBE_EVIDENCE;
const runtimeRoot = process.env.STELLA_RUNTIME_PROBE_ROOT;
const databasePath = process.env.STELLA_RUNTIME_PROBE_DATABASE;
const sessionKey = process.env.STELLA_RUNTIME_PROBE_SESSION_KEY;
const activeRuns = new Map();
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
    stableId: "semantic-host-probe",
    baseAuthorityVersion: null,
    baseChecksum: null,
    baseContent: null,
    content: { claim: "Exact Host callback claim." },
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
    api.on("gateway_start", runConfirmationProbe);
    api.on("before_prompt_build", async (event, context) => {
      const kind = runKind(event.prompt);
      if (context.runId === undefined || kind === "other") {
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
    });
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
