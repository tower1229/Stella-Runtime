export interface MemoryToolResult {
  readonly toolCallId: string;
  readonly content?: unknown;
  readonly details?: unknown;
}

export interface MemoryObservation {
  readonly toolCallId: string;
  readonly stableRefs: readonly string[];
}

export interface MemoryObservationPort<
  TToolResult = MemoryToolResult,
  TObservation = MemoryObservation,
> {
  observe(toolResult: TToolResult): TObservation | null;
}

export interface HostCapabilityManifest {
  readonly runContextRoundTrip: boolean;
  readonly embeddedWorkAdmission: boolean;
  readonly hostNextTurnInjection: boolean;
  readonly commandContinuationSuccessor: boolean;
  readonly uiNormalRpcSuccessor: boolean;
}

const stableIdPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const stableRefKeys = new Set([
  "stable_ref",
  "stable_refs",
  "source_id",
  "claim_id",
  "cognitive_id",
  "state_id",
]);

const collectStableRefs = (
  value: unknown,
  refs: Set<string>,
  key?: string,
): void => {
  if (typeof value === "string") {
    if (key !== undefined && stableRefKeys.has(key) && stableIdPattern.test(value)) {
      refs.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStableRefs(item, refs, key);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [childKey, child] of Object.entries(value)) {
    collectStableRefs(child, refs, childKey);
  }
};

export class MemoryObservationAdapter
  implements MemoryObservationPort<MemoryToolResult, MemoryObservation>
{
  readonly #observedToolCalls = new Set<string>();

  observe(toolResult: MemoryToolResult): MemoryObservation | null {
    if (this.#observedToolCalls.has(toolResult.toolCallId)) {
      return null;
    }
    this.#observedToolCalls.add(toolResult.toolCallId);

    const refs = new Set<string>();
    collectStableRefs(toolResult.content, refs);
    collectStableRefs(toolResult.details, refs);
    return refs.size === 0
      ? null
      : { toolCallId: toolResult.toolCallId, stableRefs: [...refs] };
  }

  clear(): void {
    this.#observedToolCalls.clear();
  }
}
