import type { RouterResult } from "../contracts/index.js";
import type { CognitiveProvenanceOverlay } from "../contracts/index.js";
import type { InstanceRuntimeConfig } from "../contracts/index.js";
import { validateContract } from "../contracts/index.js";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { RunScratchMap } from "../core/index.js";
import {
  buildExplicitContextPacket,
  type ExplicitContextBinding,
} from "../packet/index.js";
import {
  StrictRouter,
  type RouterOutcome,
  type RouterRegistry,
} from "../router/index.js";
import type {
  CognitiveRuntimePluginApi,
  PluginHookContext,
} from "./plugin-api.js";
import { MemoryObservationAdapter } from "./ports.js";
import {
  FileBindingCompiler,
  type ActiveRunBinding,
  type BindingCompilerPort,
} from "../runtime/binding.js";

const ROUTER_TIMEOUT_MS = 10_000;
const ROUTER_MAX_TOKENS = 512;
const ROUTER_MAX_INPUT_CHARACTERS = 16_000;
const ROUTER_MAX_OUTPUT_CHARACTERS = 16_000;
const PACKET_MAX_CHARACTERS = 32_000;

interface HookBinding {
  readonly syncGeneration: string;
  readonly authorityRevision: string;
  readonly stateViewVersion: string;
  readonly registryChecksum: string;
  readonly stateView: unknown;
  readonly registry: RouterRegistry;
  readonly routerResult: RouterOutcome;
  readonly packet: string | null;
}

export interface RuntimeMetricsSnapshot {
  readonly runsStarted: number;
  readonly runsDegraded: number;
  readonly remediationRevisions: number;
  readonly activeRuns: number;
  readonly nonLlmDurationSamplesMs: readonly number[];
}

export interface RuntimeHookOptions {
  readonly recordProvenance?: (
    overlay: CognitiveProvenanceOverlay,
  ) => Promise<void>;
  readonly bindingCompiler?: BindingCompilerPort;
}

export interface RuntimeHookController {
  metrics(): RuntimeMetricsSnapshot;
  clearLifecycle(lifecycle: "reset" | "disable" | "restart"): number;
}

const routerCompletionScope = new AsyncLocalStorage<boolean>();

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const readRuntimeConfig = (
  pluginConfig: Readonly<Record<string, unknown>> | undefined,
): InstanceRuntimeConfig | null => {
  if (pluginConfig?.runtime === undefined) {
    return null;
  }
  const result = validateContract("instance-runtime-config", pluginConfig.runtime);
  if (!result.valid) throw new Error("RUNTIME_CONFIG_INVALID");
  return structuredClone(pluginConfig.runtime) as InstanceRuntimeConfig;
};

const runIdFrom = (
  event: Readonly<Record<string, unknown>>,
  context: PluginHookContext,
): string | null => {
  const value = typeof event.runId === "string" ? event.runId : context.runId;
  return typeof value === "string" && value.length > 0 ? value : null;
};

const agentIdFrom = (context: PluginHookContext): string | null => {
  if (context.agentId !== undefined && context.agentId.length > 0) return context.agentId;
  const match = context.sessionKey?.match(/^agent:([^:]+):/);
  return match?.[1] ?? null;
};

const isPrivateMainSession = (
  sessionKey: string | undefined,
  config: InstanceRuntimeConfig,
): boolean => {
  if (sessionKey === `agent:${config.host.agent_id}:main`) return true;
  if (sessionKey === undefined) return false;
  const segments = sessionKey.split(":");
  return segments[0] === "agent" &&
    segments[1] === config.host.agent_id &&
    segments.at(-2) === "direct" &&
    segments.at(-1) === config.authority_owner.actor_id;
};

const isEligibleRun = (
  context: PluginHookContext,
  config: InstanceRuntimeConfig,
): boolean => {
  if (agentIdFrom(context) !== config.host.agent_id) return false;
  if (!isPrivateMainSession(context.sessionKey, config)) return false;
  if (context.trigger !== "user") return false;
  if (
    context.messageProvider !== config.authority_owner.provider ||
    context.senderId !== config.authority_owner.actor_id ||
    context.chatId !== config.authority_owner.actor_id
  ) {
    return false;
  }
  return config.host.eligible_scope.includes("private_main_session");
};

const completionText = (value: unknown): string => {
  if (!isRecord(value) || typeof value.text !== "string") {
    throw new Error("HOST_COMPLETION_TEXT_INVALID");
  }
  return value.text;
};

const serializeRecentMessage = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "[unserializable-message]";
  }
};

const selectPacketBinding = (
  prompt: string,
  configured: ActiveRunBinding["context"],
  result: RouterResult,
): ExplicitContextBinding => {
  const directTargets = new Set(
    (result.memory_route === "none" ? [] : result.retrieval_plan)
      .filter((step) => step.method === "direct_get")
      .map((step) => step.target)
      .filter((target): target is string => target !== null),
  );
  const frameworkIds = new Set(result.memory_route === "none" ? [] :
    [result.frameworks.primary, result.frameworks.secondary]
      .filter((id): id is string => id !== null),
  );
  const governingModuleIds = new Set(
    result.memory_route === "none" ? [] : result.governing?.modules ?? [],
  );
  const governing = configured.governing === null
    ? null
    : {
        system: configured.governing.system,
        modules: configured.governing.modules.filter((entry) =>
          governingModuleIds.has(entry.id)),
      };
  return {
    currentInput: prompt,
    stateView: configured.stateView.filter((entry) =>
      result.state_refs.includes(entry.id)),
    semanticClaims: configured.semanticClaims.filter((entry) =>
      directTargets.has(entry.id)),
    evidenceRefs: configured.evidenceRefs.filter((entry) =>
      directTargets.has(entry.id)),
    governing,
    frameworks: configured.frameworks.filter((entry) =>
      frameworkIds.has(entry.id)),
    retrievalInstructions: result.memory_route === "none"
      ? []
      : result.retrieval_plan.map((step) => step.purpose),
  };
};

const selectedInjectedIds = (result: RouterResult): ReadonlySet<string> => new Set([
  ...result.state_refs,
  ...(result.governing === null ? [] : [result.governing.system]),
  ...(result.memory_route === "none" || result.governing === null
    ? [] : result.governing.modules),
  ...(result.memory_route === "none" ? [] : [
    result.frameworks.primary,
    result.frameworks.secondary,
    ...result.retrieval_plan.map((step) => step.target),
  ].filter((id): id is string => id !== null)),
]);

const allowedRecallIds = (
  result: RouterResult,
  registry: RouterRegistry,
): ReadonlySet<string> => {
  const allowed = new Set<string>();
  for (const step of result.retrieval_plan) {
    if (step.method === "direct_get" && step.target !== null) {
      allowed.add(step.target);
      continue;
    }
    if (step.method === "search") {
      const role = step.layer === "cognitive" ? "ordinary_framework" : step.layer;
      for (const entry of registry.entries) {
        if (entry.role === role) {
          allowed.add(entry.id);
        }
      }
    }
  }
  return allowed;
};

export const registerRuntimeHooks = (
  api: CognitiveRuntimePluginApi,
  config: InstanceRuntimeConfig,
  options: RuntimeHookOptions = {},
): RuntimeHookController | null => {
  if (api.on === undefined) {
    return null;
  }
  const injectedPackets = new Map<string, string>();
  const promptBuilds = new Map<string, Promise<{ readonly prependContext: string } | undefined>>();
  const invalidatedRuns = new Set<string>();
  const cleanlyReleasingRuns = new Set<string>();
  const invalidateRun = (runId: string): void => {
    if (cleanlyReleasingRuns.delete(runId)) return;
    invalidatedRuns.add(runId);
    while (invalidatedRuns.size > config.limits.max_active_runs * 4) {
      const oldest = invalidatedRuns.values().next().value as string | undefined;
      if (oldest === undefined) break;
      invalidatedRuns.delete(oldest);
    }
  };
  const scratch = new RunScratchMap<HookBinding>({
    capacity: config.limits.max_active_runs,
    ttlMs: config.limits.drain_timeout_ms,
    onEvict: (runId) => {
      injectedPackets.delete(runId);
      promptBuilds.delete(runId);
      invalidateRun(runId);
    },
  });
  let runsStarted = 0;
  let runsDegraded = 0;
  let remediationRevisions = 0;
  let lifecycleEpoch = 0;
  const bindingCompiler = options.bindingCompiler ?? new FileBindingCompiler();
  const nonLlmDurationSamplesMs: number[] = [];
  const recordDuration = (startedAt: number): void => {
    nonLlmDurationSamplesMs.push(Math.max(0, performance.now() - startedAt));
    if (nonLlmDurationSamplesMs.length > 100) {
      nonLlmDurationSamplesMs.shift();
    }
  };
  const log = (reasonCode: string, runId?: string): void => {
    api.logger?.warn(JSON.stringify({
      component: "cognitive-runtime",
      reasonCode,
      ...(runId === undefined ? {} : { runId }),
    }));
  };

  const buildPromptContext = async (
    event: Readonly<Record<string, unknown>>,
    context: PluginHookContext,
    runId: string,
  ): Promise<{ readonly prependContext: string } | undefined> => {
    const startedEpoch = lifecycleEpoch;
    if (config.mode === "off") {
      return;
    }
    const existing = scratch.inspect(runId);
    if (existing !== null) {
      const packet = injectedPackets.get(runId);
      return config.mode === "enforce" && packet !== undefined
        ? { prependContext: packet }
        : undefined;
    }
    if (invalidatedRuns.has(runId)) {
      runsDegraded += 1;
      log("RUN_BINDING_INVALIDATED", runId);
      if (config.mode === "enforce") {
        throw new Error("COGNITIVE_BINDING_REJECTED:RUN_BINDING_INVALIDATED");
      }
      return;
    }
    if (scratch.size + promptBuilds.size >= config.limits.max_active_runs) {
      runsDegraded += 1;
      log("RUN_SCRATCH_CAPACITY", runId);
      return;
    }
    const prompt = typeof event.prompt === "string" ? event.prompt : "";
    const recentContext = Array.isArray(event.messages)
      ? event.messages.slice(-4).map(serializeRecentMessage)
      : [];
    const inputCharacters = prompt.length + recentContext.reduce(
      (total, item) => total + item.length,
      0,
    );
    if (inputCharacters > ROUTER_MAX_INPUT_CHARACTERS) {
      log("ROUTER_INPUT_LIMIT_EXCEEDED", runId);
      return;
    }
    let activeBinding: ActiveRunBinding;
    try {
      activeBinding = await bindingCompiler.compile({
        config,
        hostVersion: api.runtime.version,
        nodeVersion: process.versions.node,
      });
    } catch (error: unknown) {
      runsDegraded += 1;
      const reason = error instanceof Error
        ? (error.message.split(":", 1)[0] ?? "BINDING_COMPILATION_FAILED")
        : "BINDING_COMPILATION_FAILED";
      log(reason, runId);
      if (config.mode === "enforce") {
        throw new Error(`COGNITIVE_BINDING_REJECTED:${reason}`);
      }
      return;
    }
    try {
      const router = new StrictRouter({
        timeoutMs: ROUTER_TIMEOUT_MS,
        maxInputCharacters: ROUTER_MAX_INPUT_CHARACTERS,
        maxOutputCharacters: ROUTER_MAX_OUTPUT_CHARACTERS,
        complete: async (routerPrompt) => completionText(
          await routerCompletionScope.run(true, () => api.runtime.llm.complete({
              messages: [{ role: "user", content: routerPrompt }],
              maxTokens: ROUTER_MAX_TOKENS,
              temperature: 0,
              purpose: "cognitive-runtime.router",
            })),
        ),
      });
      const routerResult = await router.route({
        currentMessage: prompt,
        recentContext,
        stateViewVersion: activeBinding.stateViewVersion,
        activeGoverningSystem: activeBinding.activeGoverningSystem,
        syncGeneration: activeBinding.syncGeneration,
        expectedRegistryChecksum: activeBinding.registry.checksum,
        registry: activeBinding.registry,
      });
      if (startedEpoch !== lifecycleEpoch) {
        runsDegraded += 1;
        log("RUN_LIFECYCLE_INVALIDATED", runId);
        return;
      }
      let packet: string | null = null;
      if (routerResult.status === "ok") {
        packet = buildExplicitContextPacket({
          binding: selectPacketBinding(
            prompt,
            activeBinding.context,
            routerResult.result,
          ),
          memoryRoute: routerResult.result.memory_route,
          maxCharacters: PACKET_MAX_CHARACTERS,
        });
      } else {
        runsDegraded += 1;
        log(routerResult.reasonCode, runId);
      }
      await scratch.acquire(runId, {
        syncGeneration: activeBinding.syncGeneration,
        authorityRevision: activeBinding.authorityRevision,
        stateViewVersion: activeBinding.stateViewVersion,
        registryChecksum: activeBinding.registry.checksum,
        stateView: activeBinding.context.stateView,
        registry: activeBinding.registry,
        routerResult,
        packet,
      });
      runsStarted += 1;
      if (config.mode === "enforce" && packet !== null) {
        injectedPackets.set(runId, packet);
        return { prependContext: packet };
      }
    } catch (error: unknown) {
      runsDegraded += 1;
      const reason = error instanceof Error
        ? (error.message.split(":", 1)[0] ?? "RUNTIME_FAILURE")
        : "RUNTIME_FAILURE";
      log(reason, runId);
    }
  };

  api.on("before_prompt_build", async (event, context) => {
    if (routerCompletionScope.getStore() === true) {
      return;
    }
    if (config.mode === "off") {
      return;
    }
    if (!isEligibleRun(context, config)) {
      return;
    }
    const runId = runIdFrom(event, context);
    if (runId === null) {
      log("RUN_ID_REQUIRED");
      return;
    }
    const inFlight = promptBuilds.get(runId);
    if (inFlight !== undefined) {
      return inFlight;
    }
    const pending = buildPromptContext(event, context, runId);
    promptBuilds.set(runId, pending);
    try {
      return await pending;
    } finally {
      promptBuilds.delete(runId);
    }
  });

  api.on("after_tool_call", async (event, context) => {
    const startedAt = performance.now();
    const runId = runIdFrom(event, context);
    const toolCallId = typeof event.toolCallId === "string"
      ? event.toolCallId
      : context.toolCallId;
    const toolName = typeof event.toolName === "string" ? event.toolName : "";
    if (
      runId === null ||
      toolCallId === undefined ||
      !["memory_get", "memory_search"].includes(toolName)
    ) {
      return;
    }
    const snapshot = scratch.inspect(runId);
    if (snapshot === null || snapshot.binding.routerResult.status !== "ok") {
      return;
    }
    const allowedRefs = allowedRecallIds(
      snapshot.binding.routerResult.result,
      snapshot.binding.registry,
    );
    const observation = new MemoryObservationAdapter().observe({
      toolCallId,
      content: event.result,
      details: event.result,
    });
    if (observation !== null) {
      const validRefs = observation.stableRefs.filter((id) => allowedRefs.has(id));
      if (validRefs.length > 0) {
        await scratch.observe(runId, { ...observation, stableRefs: validRefs });
      }
    }
    recordDuration(startedAt);
  });

  api.on("before_agent_finalize", async (event, context) => {
    const runId = runIdFrom(event, context);
    if (runId === null) {
      return;
    }
    const snapshot = scratch.inspect(runId);
    if (snapshot === null || snapshot.binding.routerResult.status !== "ok") {
      return;
    }
    const result = snapshot.binding.routerResult.result as RouterResult;
    if (
      result.memory_route !== "required" ||
      snapshot.observations.some((item) => item.stableRefs.length > 0) ||
      !(await scratch.claimRemediation(runId))
    ) {
      return;
    }
    remediationRevisions += 1;
    return {
      action: "revise",
      reason: "COGNITIVE_RETRIEVAL_REQUIRED",
      retry: {
        instruction: "Complete the required cognitive retrieval plan, then answer.",
        idempotencyKey: `cognitive-runtime:${runId}:remediation`,
        maxAttempts: 1,
      },
    };
  });

  api.on("agent_end", async (event, context) => {
    const startedAt = performance.now();
    const runId = runIdFrom(event, context);
    if (runId === null) {
      return;
    }
    try {
      const snapshot = scratch.inspect(runId);
      if (snapshot !== null && options.recordProvenance !== undefined) {
        const successful = event.success === true;
        const sessionKey = context.sessionKey ?? "unavailable";
        const routerResult = snapshot.binding.routerResult;
        const stableRefs = [...new Set(
          snapshot.observations.flatMap((item) => item.stableRefs),
        )];
        await options.recordProvenance({
          trace_id: `trace-${runId}`,
          run_id: runId,
          session_key_hash: `sha256:${createHash("sha256").update(sessionKey).digest("hex")}`,
          sync_generation: snapshot.binding.syncGeneration,
          knowledge_snapshot: snapshot.binding.authorityRevision,
          state_view_version: snapshot.binding.stateViewVersion,
          validated_router_result: null,
          cognitive_bindings: config.mode === "enforce" && snapshot.binding.packet !== null && routerResult.status === "ok"
            ? snapshot.binding.registry.entries
                .filter((entry) => selectedInjectedIds(routerResult.result).has(entry.id))
                .map((entry) => ({
                  id: entry.id,
                  role: entry.role,
                  version: entry.version,
                  status: "injected" as const,
                }))
            : [],
          stable_refs: stableRefs.map((id) => ({ id, status: "retrieved" as const })),
          unresolved_conflicts: routerResult.status === "degraded"
            ? [routerResult.reasonCode.toLowerCase().replaceAll("_", "-")]
            : [],
          trace_status: successful
            ? (routerResult.status === "ok" ? "completed" : "degraded")
            : "failed",
          eval_eligible: successful && routerResult.status === "ok",
          created_at: new Date().toISOString(),
        });
      }
    } catch (error: unknown) {
      log("PROVENANCE_RECORD_FAILED", runId);
    } finally {
      injectedPackets.delete(runId);
      promptBuilds.delete(runId);
      invalidatedRuns.delete(runId);
      cleanlyReleasingRuns.add(runId);
      await scratch.release(runId);
      cleanlyReleasingRuns.delete(runId);
      recordDuration(startedAt);
    }
  });
  return {
    metrics: () => ({
      runsStarted,
      runsDegraded,
      remediationRevisions,
      activeRuns: scratch.size,
      nonLlmDurationSamplesMs: [...nonLlmDurationSamplesMs],
    }),
    clearLifecycle: (lifecycle) => {
      lifecycleEpoch += 1;
      injectedPackets.clear();
      promptBuilds.clear();
      return scratch.clearLifecycle(lifecycle);
    },
  };
};
