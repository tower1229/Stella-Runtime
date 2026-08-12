import type { RouterResult } from "../contracts/index.js";
import type { CognitiveProvenanceOverlay } from "../contracts/index.js";
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

const RUNTIME_MODES = ["off", "observe", "enforce"] as const;
type RuntimeMode = (typeof RUNTIME_MODES)[number];

interface RuntimeLimits {
  readonly routerTimeoutMs: number;
  readonly routerMaxTokens: number;
  readonly routerMaxInputCharacters: number;
  readonly routerMaxOutputCharacters: number;
  readonly packetMaxCharacters: number;
  readonly scratchCapacity: number;
  readonly scratchTtlMs: number;
}

interface RuntimeBindingConfig {
  readonly syncGeneration: string;
  readonly authorityRevision: string;
  readonly stateViewVersion: string;
  readonly activeGoverningSystem: string | null;
  readonly registry: RouterRegistry;
  readonly context: Omit<ExplicitContextBinding, "currentInput" | "retrievalInstructions">;
}

interface RuntimePluginConfig {
  readonly mode: RuntimeMode;
  readonly limits: RuntimeLimits;
  readonly binding: RuntimeBindingConfig;
}

interface HookBinding {
  readonly syncGeneration: string;
  readonly authorityRevision: string;
  readonly stateViewVersion: string;
  readonly registryChecksum: string;
  readonly stateView: unknown;
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
}

export interface RuntimeHookController {
  metrics(): RuntimeMetricsSnapshot;
  clearLifecycle(lifecycle: "reset" | "disable" | "restart"): number;
}

const routerCompletionScope = new AsyncLocalStorage<boolean>();

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireRecord = (
  value: unknown,
  reason: string,
): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) {
    throw new Error(reason);
  }
  return value;
};

const requireString = (value: unknown, reason: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(reason);
  }
  return value;
};

const requirePositiveInteger = (value: unknown, reason: string): number => {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(reason);
  }
  return value as number;
};

const requireArray = (value: unknown, reason: string): readonly unknown[] => {
  if (!Array.isArray(value)) {
    throw new Error(reason);
  }
  return value;
};

const parseContextEntries = (
  value: unknown,
  versioned: boolean,
  reason: string,
): readonly (ExplicitContextBinding["stateView"][number] & { readonly version?: string })[] =>
  requireArray(value, reason).map((item) => {
    const entry = requireRecord(item, reason);
    return {
      id: requireString(entry.id, reason),
      content: requireString(entry.content, reason),
      ...(versioned ? { version: requireString(entry.version, reason) } : {}),
    };
  });

export const readRuntimeConfig = (
  pluginConfig: Readonly<Record<string, unknown>> | undefined,
): RuntimePluginConfig | null => {
  if (pluginConfig?.runtime === undefined) {
    return null;
  }
  const runtime = requireRecord(pluginConfig.runtime, "RUNTIME_CONFIG_INVALID");
  if (!RUNTIME_MODES.includes(runtime.mode as RuntimeMode)) {
    throw new Error("RUNTIME_MODE_INVALID");
  }
  const limits = requireRecord(runtime.limits, "RUNTIME_LIMITS_INVALID");
  const binding = requireRecord(runtime.binding, "RUNTIME_BINDING_INVALID");
  const registry = requireRecord(binding.registry, "RUNTIME_REGISTRY_INVALID");
  const context = requireRecord(binding.context, "RUNTIME_CONTEXT_INVALID");
  const entries = requireArray(registry.entries, "RUNTIME_REGISTRY_INVALID").map((item) => {
    const entry = requireRecord(item, "RUNTIME_REGISTRY_INVALID");
    const role = requireString(entry.role, "RUNTIME_REGISTRY_INVALID");
    if (!["evidence", "semantic", "current_state", "governing_system", "governing_module", "ordinary_framework"].includes(role)) {
      throw new Error("RUNTIME_REGISTRY_INVALID");
    }
    return {
      id: requireString(entry.id, "RUNTIME_REGISTRY_INVALID"),
      role: role as RouterRegistry["entries"][number]["role"],
      version: requireString(entry.version, "RUNTIME_REGISTRY_INVALID"),
      syncGeneration: requireString(entry.syncGeneration, "RUNTIME_REGISTRY_INVALID"),
      checksum: requireString(entry.checksum, "RUNTIME_REGISTRY_INVALID"),
      ...(entry.governedBy === undefined ? {} : {
        governedBy: requireString(entry.governedBy, "RUNTIME_REGISTRY_INVALID"),
      }),
    };
  });
  const governingValue = context.governing;
  const governing = governingValue === null
    ? null
    : (() => {
        const value = requireRecord(governingValue, "RUNTIME_CONTEXT_INVALID");
        const systems = parseContextEntries([value.system], true, "RUNTIME_CONTEXT_INVALID");
        return {
          system: systems[0] as ExplicitContextBinding["governing"] extends infer T
            ? T extends { readonly system: infer S } ? S : never
            : never,
          modules: parseContextEntries(value.modules, true, "RUNTIME_CONTEXT_INVALID") as ExplicitContextBinding["frameworks"],
        };
      })();
  const syncGeneration = requireString(binding.syncGeneration, "SYNC_GENERATION_REQUIRED");
  const activeGoverningSystem = binding.activeGoverningSystem === null
    ? null
    : requireString(binding.activeGoverningSystem, "GOVERNING_BINDING_INVALID");
  const registryById = new Map(entries.map((entry) => [entry.id, entry]));
  if (registryById.size !== entries.length) {
    throw new Error("RUNTIME_REGISTRY_INVALID");
  }
  const assertContextEntry = (
    entry: { readonly id: string; readonly version?: string },
    role: RouterRegistry["entries"][number]["role"],
  ): void => {
    const registered = registryById.get(entry.id);
    if (
      registered === undefined ||
      registered.role !== role ||
      registered.syncGeneration !== syncGeneration ||
      (entry.version !== undefined && registered.version !== entry.version)
    ) {
      throw new Error("RUNTIME_CONTEXT_REGISTRY_MISMATCH");
    }
  };
  const stateView = parseContextEntries(context.stateView, false, "RUNTIME_CONTEXT_INVALID");
  const semanticClaims = parseContextEntries(context.semanticClaims, false, "RUNTIME_CONTEXT_INVALID");
  const evidenceRefs = parseContextEntries(context.evidenceRefs, false, "RUNTIME_CONTEXT_INVALID");
  const frameworks = parseContextEntries(context.frameworks, true, "RUNTIME_CONTEXT_INVALID") as ExplicitContextBinding["frameworks"];
  stateView.forEach((entry) => assertContextEntry(entry, "current_state"));
  semanticClaims.forEach((entry) => assertContextEntry(entry, "semantic"));
  evidenceRefs.forEach((entry) => assertContextEntry(entry, "evidence"));
  frameworks.forEach((entry) => assertContextEntry(entry, "ordinary_framework"));
  if ((governing === null) !== (activeGoverningSystem === null)) {
    throw new Error("GOVERNING_BINDING_INVALID");
  }
  if (governing !== null) {
    if (governing.system.id !== activeGoverningSystem) {
      throw new Error("GOVERNING_BINDING_INVALID");
    }
    assertContextEntry(governing.system, "governing_system");
    governing.modules.forEach((entry) => {
      assertContextEntry(entry, "governing_module");
      if (registryById.get(entry.id)?.governedBy !== activeGoverningSystem) {
        throw new Error("RUNTIME_CONTEXT_REGISTRY_MISMATCH");
      }
    });
  }
  return {
    mode: runtime.mode as RuntimeMode,
    limits: {
      routerTimeoutMs: requirePositiveInteger(limits.routerTimeoutMs, "ROUTER_TIMEOUT_INVALID"),
      routerMaxTokens: requirePositiveInteger(limits.routerMaxTokens, "ROUTER_TOKEN_LIMIT_INVALID"),
      routerMaxInputCharacters: requirePositiveInteger(limits.routerMaxInputCharacters, "ROUTER_INPUT_LIMIT_INVALID"),
      routerMaxOutputCharacters: requirePositiveInteger(limits.routerMaxOutputCharacters, "ROUTER_OUTPUT_LIMIT_INVALID"),
      packetMaxCharacters: requirePositiveInteger(limits.packetMaxCharacters, "PACKET_LIMIT_INVALID"),
      scratchCapacity: requirePositiveInteger(limits.scratchCapacity, "SCRATCH_CAPACITY_INVALID"),
      scratchTtlMs: requirePositiveInteger(limits.scratchTtlMs, "SCRATCH_TTL_INVALID"),
    },
    binding: {
      syncGeneration,
      authorityRevision: requireString(binding.authorityRevision, "AUTHORITY_REVISION_REQUIRED"),
      stateViewVersion: requireString(binding.stateViewVersion, "STATE_VIEW_VERSION_REQUIRED"),
      activeGoverningSystem,
      registry: {
        checksum: requireString(registry.checksum, "REGISTRY_CHECKSUM_REQUIRED"),
        entries,
      },
      context: {
        stateView,
        semanticClaims,
        evidenceRefs,
        governing,
        frameworks,
      },
    },
  };
};

const runIdFrom = (
  event: Readonly<Record<string, unknown>>,
  context: PluginHookContext,
): string | null => {
  const value = typeof event.runId === "string" ? event.runId : context.runId;
  return typeof value === "string" && value.length > 0 ? value : null;
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
  configured: RuntimeBindingConfig["context"],
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
  config: RuntimePluginConfig,
  options: RuntimeHookOptions = {},
): RuntimeHookController | null => {
  if (api.on === undefined) {
    return null;
  }
  const injectedPackets = new Map<string, string>();
  const promptBuilds = new Map<string, Promise<{ readonly prependContext: string } | undefined>>();
  const scratch = new RunScratchMap<HookBinding>({
    capacity: config.limits.scratchCapacity,
    ttlMs: config.limits.scratchTtlMs,
    onEvict: (runId) => {
      injectedPackets.delete(runId);
      promptBuilds.delete(runId);
    },
  });
  let runsStarted = 0;
  let runsDegraded = 0;
  let remediationRevisions = 0;
  let lifecycleEpoch = 0;
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
    if (scratch.size + promptBuilds.size >= config.limits.scratchCapacity) {
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
    if (inputCharacters > config.limits.routerMaxInputCharacters) {
      log("ROUTER_INPUT_LIMIT_EXCEEDED", runId);
      return;
    }
    try {
      const router = new StrictRouter({
        timeoutMs: config.limits.routerTimeoutMs,
        maxInputCharacters: config.limits.routerMaxInputCharacters,
        maxOutputCharacters: config.limits.routerMaxOutputCharacters,
        complete: async (routerPrompt) => completionText(
          await routerCompletionScope.run(true, () => api.runtime.llm.complete({
              messages: [{ role: "user", content: routerPrompt }],
              maxTokens: config.limits.routerMaxTokens,
              temperature: 0,
              purpose: "cognitive-runtime.router",
            })),
        ),
      });
      const routerResult = await router.route({
        currentMessage: prompt,
        recentContext,
        stateViewVersion: config.binding.stateViewVersion,
        activeGoverningSystem: config.binding.activeGoverningSystem,
        syncGeneration: config.binding.syncGeneration,
        expectedRegistryChecksum: config.binding.registry.checksum,
        registry: config.binding.registry,
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
            config.binding.context,
            routerResult.result,
          ),
          memoryRoute: routerResult.result.memory_route,
          maxCharacters: config.limits.packetMaxCharacters,
        });
      } else {
        runsDegraded += 1;
        log(routerResult.reasonCode, runId);
      }
      await scratch.acquire(runId, {
        syncGeneration: config.binding.syncGeneration,
        authorityRevision: config.binding.authorityRevision,
        stateViewVersion: config.binding.stateViewVersion,
        registryChecksum: config.binding.registry.checksum,
        stateView: config.binding.context.stateView,
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
      config.binding.registry,
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
            ? config.binding.registry.entries
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
      await scratch.release(runId);
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
