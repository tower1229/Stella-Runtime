import { createHash } from "node:crypto";

import type { RouterResult } from "../contracts/index.js";
import { validateContract } from "../contracts/index.js";

export interface RouterPort<TRequest = unknown, TResult = unknown> {
  route(request: TRequest): Promise<TResult>;
}

export type RegistryRole =
  | "evidence"
  | "semantic"
  | "current_state"
  | "governing_system"
  | "governing_module"
  | "ordinary_framework";

export interface RouterRegistryEntry {
  readonly id: string;
  readonly role: RegistryRole;
  readonly version: string;
  readonly syncGeneration: string;
  readonly checksum: string;
  readonly governedBy?: string;
}

export interface RouterRegistry {
  readonly checksum: string;
  readonly entries: readonly RouterRegistryEntry[];
}

export interface RouterRequest {
  readonly currentMessage: string;
  readonly recentContext: readonly string[];
  readonly stateViewVersion: string;
  readonly activeGoverningSystem: string | null;
  readonly syncGeneration: string;
  readonly expectedRegistryChecksum: string;
  readonly registry: RouterRegistry;
}

export type RouterDegradedReason =
  | "ROUTER_TIMEOUT"
  | "ROUTER_COMPLETION_FAILED"
  | "ROUTER_EMPTY_OUTPUT"
  | "ROUTER_NON_JSON_OUTPUT"
  | "ROUTER_SCHEMA_INVALID"
  | "ROUTER_REGISTRY_CHECKSUM_MISMATCH"
  | "ROUTER_REGISTRY_DUPLICATE_ID"
  | "ROUTER_ENTRY_CHECKSUM_INVALID"
  | "ROUTER_UNKNOWN_ID"
  | "ROUTER_ROLE_MISMATCH"
  | "ROUTER_GENERATION_MISMATCH"
  | "ROUTER_VERSION_MISMATCH"
  | "ROUTER_GOVERNING_BINDING_MISMATCH";

export type RouterOutcome =
  | { readonly status: "ok"; readonly result: RouterResult }
  | { readonly status: "degraded"; readonly reasonCode: RouterDegradedReason };

export interface StrictRouterOptions {
  readonly complete: (prompt: string) => Promise<string>;
  readonly timeoutMs?: number;
}

const checksumPattern = /^sha256:[a-f0-9]{64}$/;

export const calculateRegistryChecksum = (
  entries: readonly RouterRegistryEntry[],
): string => {
  const canonicalEntries = [...entries]
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    )
    .map((entry) => ({
      id: entry.id,
      role: entry.role,
      version: entry.version,
      syncGeneration: entry.syncGeneration,
      checksum: entry.checksum,
      ...(entry.governedBy === undefined
        ? {}
        : { governedBy: entry.governedBy }),
    }));
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalEntries))
    .digest("hex")}`;
};

class RouterTimeoutError extends Error {}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RouterTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

const selectedEntries = (
  result: RouterResult,
): readonly { readonly id: string; readonly role: RegistryRole; readonly version?: string; readonly governedBy?: string }[] => {
  const selections: {
    id: string;
    role: RegistryRole;
    version?: string;
    governedBy?: string;
  }[] = result.state_refs.map((id) => ({ id, role: "current_state" }));

  if (result.governing !== null) {
    const governingSystem = result.governing.system;
    selections.push({
      id: governingSystem,
      role: "governing_system",
      version: result.governing.kernel_version,
    });
    selections.push(
      ...result.governing.modules.map((id) => ({
        id,
        role: "governing_module" as const,
        governedBy: governingSystem,
      })),
    );
  }

  for (const id of [result.frameworks.primary, result.frameworks.secondary]) {
    if (id !== null) {
      selections.push({ id, role: "ordinary_framework" });
    }
  }

  for (const step of result.retrieval_plan) {
    if (step.method === "direct_get" && step.target !== null) {
      const role = step.layer === "cognitive" ? "ordinary_framework" : step.layer;
      selections.push({ id: step.target, role });
    }
  }
  return selections;
};

const validateRegistry = (
  request: RouterRequest,
  result: RouterResult,
): RouterDegradedReason | null => {
  if (request.registry.checksum !== request.expectedRegistryChecksum) {
    return "ROUTER_REGISTRY_CHECKSUM_MISMATCH";
  }
  const selectedGoverningSystem = result.governing?.system ?? null;
  if (selectedGoverningSystem !== request.activeGoverningSystem) {
    return "ROUTER_GOVERNING_BINDING_MISMATCH";
  }
  if (
    result.frameworks.primary !== null &&
    result.frameworks.primary === result.frameworks.secondary
  ) {
    return "ROUTER_ROLE_MISMATCH";
  }

  const entries = new Map(request.registry.entries.map((entry) => [entry.id, entry]));
  if (entries.size !== request.registry.entries.length) {
    return "ROUTER_REGISTRY_DUPLICATE_ID";
  }
  for (const selection of selectedEntries(result)) {
    const entry = entries.get(selection.id);
    if (entry === undefined) {
      return "ROUTER_UNKNOWN_ID";
    }
    if (entry.syncGeneration !== request.syncGeneration) {
      return "ROUTER_GENERATION_MISMATCH";
    }
    if (entry.role !== selection.role || entry.governedBy !== selection.governedBy) {
      return "ROUTER_ROLE_MISMATCH";
    }
    if (selection.version !== undefined && entry.version !== selection.version) {
      return "ROUTER_VERSION_MISMATCH";
    }
    if (!checksumPattern.test(entry.checksum)) {
      return "ROUTER_ENTRY_CHECKSUM_INVALID";
    }
  }
  for (const entry of request.registry.entries) {
    if (entry.syncGeneration !== request.syncGeneration) {
      return "ROUTER_GENERATION_MISMATCH";
    }
    if (
      entry.version.trim().length === 0 ||
      !checksumPattern.test(entry.checksum)
    ) {
      return "ROUTER_ENTRY_CHECKSUM_INVALID";
    }
  }
  if (
    calculateRegistryChecksum(request.registry.entries) !==
    request.registry.checksum
  ) {
    return "ROUTER_REGISTRY_CHECKSUM_MISMATCH";
  }
  return null;
};

export class StrictRouter implements RouterPort<RouterRequest, RouterOutcome> {
  readonly #complete: (prompt: string) => Promise<string>;
  readonly #timeoutMs: number;

  constructor(options: StrictRouterOptions) {
    this.#complete = options.complete;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async route(request: RouterRequest): Promise<RouterOutcome> {
    let output: string;
    try {
      output = await withTimeout(
        this.#complete(
          JSON.stringify({
            instruction: "Return exactly one Router Result JSON object.",
            current_message: request.currentMessage,
            recent_context: request.recentContext,
            state_view_version: request.stateViewVersion,
            active_governing_system: request.activeGoverningSystem,
            sync_generation: request.syncGeneration,
            registry: request.registry,
          }),
        ),
        this.#timeoutMs,
      );
    } catch (error: unknown) {
      return {
        status: "degraded",
        reasonCode:
          error instanceof RouterTimeoutError
            ? "ROUTER_TIMEOUT"
            : "ROUTER_COMPLETION_FAILED",
      };
    }

    if (output.trim().length === 0) {
      return { status: "degraded", reasonCode: "ROUTER_EMPTY_OUTPUT" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(output) as unknown;
    } catch {
      return { status: "degraded", reasonCode: "ROUTER_NON_JSON_OUTPUT" };
    }

    if (!validateContract("router-result", parsed).valid) {
      return { status: "degraded", reasonCode: "ROUTER_SCHEMA_INVALID" };
    }
    const result = parsed as RouterResult;
    const registryFailure = validateRegistry(request, result);
    if (registryFailure !== null) {
      return { status: "degraded", reasonCode: registryFailure };
    }
    return { status: "ok", result };
  }
}
