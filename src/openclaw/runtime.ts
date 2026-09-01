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
  type RouterDegradedReason,
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
import { closeMaintenanceGate, loadMaintenanceGate } from "../sync/index.js";

const ROUTER_TIMEOUT_MS = 10_000;
const ROUTER_MAX_TOKENS = 512;
const ROUTER_MAX_INPUT_CHARACTERS = 16_000;
const ROUTER_MAX_OUTPUT_CHARACTERS = 16_000;
const PACKET_MAX_CHARACTERS = 32_000;

const BINDING_FAILURE_REASONS = [
  "ACTIVATION_CONFIG_IDENTITY_STALE",
  "ACTIVATION_HOST_IDENTITY_STALE",
  "ACTIVATION_RECEIPT_INVALID",
  "ACTIVATION_RECEIPT_MISMATCH",
  "ACTIVATION_RECEIPT_MISSING",
  "ACTIVE_BINDING_GENERATION_MISMATCH",
  "ACTIVE_BINDING_INSTANCE_MISMATCH",
  "ACTIVE_GENERATION_INVALID",
  "ACTIVE_GENERATION_POINTER_INVALID",
  "ACTIVE_GENERATION_POINTER_MISSING",
  "ACTIVE_DOMAIN_POINTER_DRIFT",
  "ACTIVE_DOMAIN_PROJECTION_UNAVAILABLE",
  "ACTIVE_DOMAIN_INPUT_MISMATCH",
  "ACTIVE_GOVERNING_CHECKSUM_MISMATCH",
  "ACTIVE_GOVERNING_INVALID",
  "ACTIVE_MANIFEST_CHECKSUM_MISMATCH",
  "ACTIVE_PROJECTION_CHECKSUM_MISMATCH",
  "ACTIVE_PROJECTION_GENERATION_MISMATCH",
  "ACTIVE_PROJECTION_INVALID",
  "ACTIVE_PROJECTION_MISSING",
  "ACTIVE_PROJECTION_REGISTRY_MISMATCH",
  "ACTIVE_REGISTRY_CHECKSUM_MISMATCH",
  "ACTIVE_REGISTRY_GENERATION_MISMATCH",
  "ACTIVE_REGISTRY_INVALID",
  "INCOMPATIBLE_HOST",
  "RUNTIME_CONFIG_IDENTITY_INVALID",
  "STATE_VIEW_INVALID",
  "STATE_VIEW_REGISTRY_ID_COLLISION",
] as const;

const DOMAIN_BINDING_FAILURE_REASONS = [
  "ACTIVE_DOMAIN_POINTER_DRIFT",
  "ACTIVE_DOMAIN_PROJECTION_UNAVAILABLE",
  "ACTIVE_DOMAIN_INPUT_MISMATCH",
] as const;

const HEALTH_GATE_REASONS = [
  "ACTIVE_GENERATION_UNAVAILABLE",
  "AUTHORITY_INPUT_INVALID",
  "CONFIG_DRIFT",
  "DOMAIN_PROJECTION_DRIFT",
  "HEALTH_RECONCILIATION_MISSING",
  "INCOMPATIBLE_HOST",
  "INDEX_DRIFT",
  "PLUGIN_DISCOVERY_FAILED",
  "PUBLIC_CORPUS_UNHEALTHY",
  "RUNTIME_STORAGE_UNAVAILABLE",
  "STALE_RECEIPT",
] as const;

const SCRATCH_FAILURE_REASONS = ["RUN_SCRATCH_CAPACITY"] as const;

type RuntimeRejectionReason =
  | RouterDegradedReason
  | typeof BINDING_FAILURE_REASONS[number]
  | typeof HEALTH_GATE_REASONS[number]
  | typeof SCRATCH_FAILURE_REASONS[number]
  | "BINDING_COMPILATION_FAILED"
  | "MAINTENANCE_GATE_CLOSED"
  | "MAINTENANCE_GATE_INVALID"
  | "RUN_BINDING_INVALIDATED"
  | "RUN_ID_REQUIRED"
  | "RUN_LIFECYCLE_INVALIDATED"
  | "RUNTIME_FAILURE"
  | "RUNTIME_HEALTH_GATED";

const isDomainBindingFailure = (
  reason: RuntimeRejectionReason,
): reason is typeof DOMAIN_BINDING_FAILURE_REASONS[number] =>
  (DOMAIN_BINDING_FAILURE_REASONS as readonly RuntimeRejectionReason[]).includes(reason);

class EligibleRunRejectedError extends Error {
  constructor(readonly reasonCode: RuntimeRejectionReason) {
    super(`COGNITIVE_BINDING_REJECTED:${reasonCode}`);
  }
}

const boundedValue = <
  TAllowed extends RuntimeRejectionReason,
  TFallback extends RuntimeRejectionReason,
>(
  candidate: string | undefined,
  allowed: readonly TAllowed[],
  fallback: TFallback,
): TAllowed | TFallback =>
  candidate !== undefined && allowed.some((reason) => reason === candidate)
    ? candidate as TAllowed
    : fallback;

const boundedReason = <
  TAllowed extends RuntimeRejectionReason,
  TFallback extends RuntimeRejectionReason,
>(
  error: unknown,
  allowed: readonly TAllowed[],
  fallback: TFallback,
): TAllowed | TFallback => {
  const candidate = error instanceof Error
    ? error.message.split(":", 1)[0]
    : undefined;
  return boundedValue(candidate, allowed, fallback);
};

interface HookBinding {
  readonly syncGeneration: string;
  readonly authorityRevision: string;
  readonly stateViewVersion: string;
  readonly registryChecksum: string;
  readonly stateView: unknown;
  readonly registry: RouterRegistry;
  readonly routerResult: RouterOutcome;
  readonly packet: string | null;
  readonly activeBinding: ActiveRunBinding;
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
  readonly healthGate?: {
    checkRunGate(): Promise<{
      readonly allowed: boolean;
      readonly reasonCodes: readonly string[];
    }>;
    reconcile?(trigger: "detected_drift"): Promise<unknown>;
    recordLifecycle?(outcome: "gated"): void;
  };
}

export interface RuntimeHookController {
  metrics(): RuntimeMetricsSnapshot;
  clearLifecycle(lifecycle: "reset" | "disable" | "restart"): number;
  closeAdmission(targetSourceRevision: string): void;
  openAdmission(): void;
  drain(timeoutMs: number): Promise<void>;
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
    (context.senderId !== undefined &&
      context.senderId !== config.authority_owner.actor_id) ||
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

const isRouterConversationMessage = (value: unknown): boolean =>
  !isRecord(value) || value.role === undefined ||
  value.role === "user" || value.role === "assistant";

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
  const rejectedRuns = new Map<string, RuntimeRejectionReason>();
  const invalidatedRuns = new Set<string>();
  const cleanlyReleasingRuns = new Set<string>();
  const trimOldestRunIds = (collection: {
    readonly size: number;
    keys(): IterableIterator<string>;
    delete(runId: string): boolean;
  }): void => {
    while (collection.size > config.limits.max_active_runs * 4) {
      const oldest = collection.keys().next().value;
      if (oldest === undefined) break;
      collection.delete(oldest);
    }
  };
  const invalidateRun = (runId: string): void => {
    if (cleanlyReleasingRuns.delete(runId)) return;
    invalidatedRuns.add(runId);
    trimOldestRunIds(invalidatedRuns);
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
  let admissionClosed = false;
  const bindingCompiler: BindingCompilerPort = options.bindingCompiler ?? new FileBindingCompiler();
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
  const rejectUnavailable = (
    reasonCode: RuntimeRejectionReason,
    runId?: string,
  ): undefined => {
    let boundedReasonCode = reasonCode;
    if (config.mode === "enforce") {
      try {
        options.healthGate?.recordLifecycle?.("gated");
      } catch {
        boundedReasonCode = "RUNTIME_FAILURE";
      }
    }
    runsDegraded += 1;
    log(boundedReasonCode, runId);
    if (config.mode === "enforce") {
      if (runId !== undefined && !rejectedRuns.has(runId)) {
        rejectedRuns.set(runId, boundedReasonCode);
        trimOldestRunIds(rejectedRuns);
      }
      throw new EligibleRunRejectedError(boundedReasonCode);
    }
  };

  const rejectDomainFailure = async (
    reasonCode: typeof DOMAIN_BINDING_FAILURE_REASONS[number],
    runId: string,
    targetSourceRevision?: string,
  ): Promise<never> => {
    admissionClosed = true;
    try {
      await closeMaintenanceGate(
        config.runtime_storage,
        targetSourceRevision,
      );
    } catch {
      log("MAINTENANCE_GATE_INVALID", runId);
    }
    await options.healthGate?.reconcile?.("detected_drift").catch(() => undefined);
    try {
      options.healthGate?.recordLifecycle?.("gated");
    } catch {
      // Lifecycle metrics must not weaken the final-request barrier.
    }
    runsDegraded += 1;
    log(reasonCode, runId);
    rejectedRuns.set(runId, reasonCode);
    trimOldestRunIds(rejectedRuns);
    throw new EligibleRunRejectedError(reasonCode);
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
      try {
        await bindingCompiler.revalidate?.(existing.binding.activeBinding, {
          config,
          hostVersion: api.runtime.version,
          nodeVersion: process.versions.node,
        });
      } catch (error: unknown) {
        const reason = boundedReason(
          error,
          BINDING_FAILURE_REASONS,
          "BINDING_COMPILATION_FAILED",
        );
        if (isDomainBindingFailure(reason)) {
          return rejectDomainFailure(reason, runId, existing.binding.authorityRevision);
        }
        return rejectUnavailable(reason, runId);
      }
      const packet = injectedPackets.get(runId);
      return config.mode === "enforce" && packet !== undefined
        ? { prependContext: packet }
        : undefined;
    }
    if (admissionClosed) {
      return rejectUnavailable("MAINTENANCE_GATE_CLOSED", runId);
    }
    let maintenanceGate;
    try {
      maintenanceGate = await loadMaintenanceGate(config.runtime_storage);
    } catch (error: unknown) {
      return rejectUnavailable("MAINTENANCE_GATE_INVALID", runId);
    }
    if (maintenanceGate !== null) {
      return rejectUnavailable("MAINTENANCE_GATE_CLOSED", runId);
    }
    if (options.healthGate !== undefined) {
      const health = await options.healthGate.checkRunGate();
      if (!health.allowed) {
        const candidate = health.reasonCodes[0];
        const reason = boundedValue(
          candidate,
          HEALTH_GATE_REASONS,
          "RUNTIME_HEALTH_GATED",
        );
        await options.healthGate.reconcile?.("detected_drift").catch(() => undefined);
        if (config.mode === "enforce") {
          return rejectUnavailable(reason, runId);
        }
        rejectUnavailable(reason, runId);
      }
    }
    if (invalidatedRuns.has(runId)) {
      return rejectUnavailable("RUN_BINDING_INVALIDATED", runId);
    }
    if (scratch.size + promptBuilds.size >= config.limits.max_active_runs) {
      return rejectUnavailable("RUN_SCRATCH_CAPACITY", runId);
    }
    const prompt = typeof event.prompt === "string" ? event.prompt : "";
    const recentContext = Array.isArray(event.messages)
      ? event.messages
          .filter(isRouterConversationMessage)
          .slice(-4)
          .map(serializeRecentMessage)
      : [];
    const inputCharacters = prompt.length + recentContext.reduce(
      (total, item) => total + item.length,
      0,
    );
    if (inputCharacters > ROUTER_MAX_INPUT_CHARACTERS) {
      return rejectUnavailable("ROUTER_INPUT_LIMIT_EXCEEDED", runId);
    }
    let activeBinding: ActiveRunBinding;
    try {
      activeBinding = await bindingCompiler.compile({
        config,
        hostVersion: api.runtime.version,
        nodeVersion: process.versions.node,
      });
    } catch (error: unknown) {
      const reason = boundedReason(
        error,
        BINDING_FAILURE_REASONS,
        "BINDING_COMPILATION_FAILED",
      );
      if (isDomainBindingFailure(reason)) {
        return rejectDomainFailure(reason, runId);
      }
      await options.healthGate?.reconcile?.("detected_drift").catch(() => undefined);
      return rejectUnavailable(reason, runId);
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
        return rejectUnavailable("RUN_LIFECYCLE_INVALIDATED", runId);
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
        rejectUnavailable(routerResult.reasonCode, runId);
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
        activeBinding,
      });
      runsStarted += 1;
      if (config.mode === "enforce" && packet !== null) {
        injectedPackets.set(runId, packet);
        return { prependContext: packet };
      }
    } catch (error: unknown) {
      if (error instanceof EligibleRunRejectedError) throw error;
      const reason = boundedReason(
        error,
        SCRATCH_FAILURE_REASONS,
        "RUNTIME_FAILURE",
      );
      return rejectUnavailable(reason, runId);
    }
  };

  const prepareEligibleRun = async (
    event: Readonly<Record<string, unknown>>,
    context: PluginHookContext,
  ): Promise<
    | { readonly eligible: false }
    | {
        readonly eligible: true;
        readonly promptContext: { readonly prependContext: string } | undefined;
      }
  > => {
    if (routerCompletionScope.getStore() === true) {
      return { eligible: false };
    }
    if (config.mode === "off" || !isEligibleRun(context, config)) {
      return { eligible: false };
    }
    const runId = runIdFrom(event, context);
    if (runId === null) {
      rejectUnavailable("RUN_ID_REQUIRED");
      return { eligible: true, promptContext: undefined };
    }
    const rejectedReason = rejectedRuns.get(runId);
    if (rejectedReason !== undefined) {
      throw new EligibleRunRejectedError(rejectedReason);
    }
    try {
      const inFlight = promptBuilds.get(runId);
      if (inFlight !== undefined) {
        await inFlight;
        return {
          eligible: true,
          promptContext: await buildPromptContext(event, context, runId),
        };
      }
      const pending = buildPromptContext(event, context, runId);
      promptBuilds.set(runId, pending);
      try {
        return { eligible: true, promptContext: await pending };
      } finally {
        promptBuilds.delete(runId);
      }
    } catch (error: unknown) {
      if (error instanceof EligibleRunRejectedError) throw error;
      rejectUnavailable("RUNTIME_FAILURE", runId);
      return { eligible: true, promptContext: undefined };
    }
  };

  api.on("before_agent_run", async (event, context) => {
    try {
      const preparation = await prepareEligibleRun(event, context);
      return preparation.eligible ? { outcome: "pass" } : undefined;
    } catch (error: unknown) {
      if (!(error instanceof EligibleRunRejectedError)) throw error;
      return {
        outcome: "block",
        reason: error.message,
        message: "Cognitive Runtime is unavailable for this Eligible Run.",
        category: "cognitive_runtime_unavailable",
        metadata: { reasonCode: error.reasonCode },
      };
    }
  });

  api.on("before_prompt_build", async (event, context) => {
    const preparation = await prepareEligibleRun(event, context);
    return preparation.eligible ? preparation.promptContext : undefined;
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
      rejectedRuns.delete(runId);
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
      for (const runId of rejectedRuns.keys()) invalidatedRuns.add(runId);
      trimOldestRunIds(invalidatedRuns);
      rejectedRuns.clear();
      return scratch.clearLifecycle(lifecycle);
    },
    closeAdmission: (_targetSourceRevision) => {
      admissionClosed = true;
    },
    openAdmission: () => {
      admissionClosed = false;
    },
    drain: async (timeoutMs) => {
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
        throw new Error("RUN_DRAIN_TIMEOUT_INVALID");
      }
      const deadline = Date.now() + timeoutMs;
      while (scratch.size + promptBuilds.size > 0) {
        if (Date.now() >= deadline) {
          throw new Error("RUN_DRAIN_TIMEOUT");
        }
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
      }
    },
  };
};
