export interface RunBinding {
  readonly syncGeneration: string;
  readonly authorityRevision: string;
  readonly stateViewVersion: string;
  readonly registryChecksum: string;
  readonly stateView: unknown;
  readonly routerResult: unknown;
}

export interface RunObservation {
  readonly toolCallId: string;
  readonly stableRefs: readonly string[];
}

export interface RunScratchSnapshot<TBinding = RunBinding> {
  readonly runId: string;
  readonly binding: Readonly<TBinding>;
  readonly observations: readonly RunObservation[];
  readonly remediationClaimed: boolean;
}

export interface RunScratchPort<
  TBinding = RunBinding,
  TObservation = RunObservation,
  TRemediationClaim = boolean,
> {
  acquire(runId: string, binding: TBinding): Promise<RunScratchSnapshot<TBinding>>;
  observe(runId: string, observation: TObservation): Promise<void>;
  claimRemediation(runId: string): Promise<TRemediationClaim>;
  release(runId: string): Promise<void>;
}

export type RunScratchLifecycle = "reset" | "disable" | "restart";

export interface RunScratchMapOptions {
  readonly capacity: number;
  readonly ttlMs: number;
  readonly now?: () => number;
}

interface MutableScratch<TBinding> {
  readonly runId: string;
  readonly binding: Readonly<TBinding>;
  readonly bindingFingerprint: string;
  readonly observations: Map<string, RunObservation>;
  remediationClaimed: boolean;
  expiresAt: number;
}

const deepFreeze = <T>(value: T): Readonly<T> => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
};

const fingerprint = (value: unknown): string => JSON.stringify(value);

export class RunScratchMap<TBinding extends RunBinding = RunBinding>
  implements RunScratchPort<TBinding>
{
  readonly #capacity: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #runs = new Map<string, MutableScratch<TBinding>>();

  constructor(options: RunScratchMapOptions) {
    if (!Number.isInteger(options.capacity) || options.capacity < 1) {
      throw new Error("RUN_SCRATCH_CAPACITY_INVALID");
    }
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error("RUN_SCRATCH_TTL_INVALID");
    }
    this.#capacity = options.capacity;
    this.#ttlMs = options.ttlMs;
    this.#now = options.now ?? Date.now;
  }

  async acquire(
    runId: string,
    binding: TBinding,
  ): Promise<RunScratchSnapshot<TBinding>> {
    this.#assertRunId(runId);
    this.cleanupExpired();
    const bindingFingerprint = fingerprint(binding);
    const existing = this.#runs.get(runId);
    if (existing !== undefined) {
      if (existing.bindingFingerprint !== bindingFingerprint) {
        throw new Error(`RUN_BINDING_CONFLICT:${runId}`);
      }
      this.#touch(existing);
      return this.#snapshot(existing);
    }
    if (this.#runs.size >= this.#capacity) {
      throw new Error("RUN_SCRATCH_CAPACITY");
    }

    const stored: MutableScratch<TBinding> = {
      runId,
      binding: deepFreeze(structuredClone(binding)),
      bindingFingerprint,
      observations: new Map(),
      remediationClaimed: false,
      expiresAt: this.#now() + this.#ttlMs,
    };
    this.#runs.set(runId, stored);
    return this.#snapshot(stored);
  }

  async observe(runId: string, observation: RunObservation): Promise<void> {
    const run = this.#require(runId);
    if (!run.observations.has(observation.toolCallId)) {
      run.observations.set(
        observation.toolCallId,
        deepFreeze({
          toolCallId: observation.toolCallId,
          stableRefs: [...new Set(observation.stableRefs)],
        }),
      );
    }
    this.#touch(run);
  }

  async claimRemediation(runId: string): Promise<boolean> {
    const run = this.#require(runId);
    if (run.remediationClaimed) {
      return false;
    }
    run.remediationClaimed = true;
    this.#touch(run);
    return true;
  }

  async release(runId: string): Promise<void> {
    this.#runs.delete(runId);
  }

  inspect(runId: string): RunScratchSnapshot<TBinding> | null {
    const run = this.#runs.get(runId);
    return run === undefined ? null : this.#snapshot(run);
  }

  cleanupExpired(): number {
    const now = this.#now();
    let removed = 0;
    for (const [runId, run] of this.#runs) {
      if (run.expiresAt <= now) {
        this.#runs.delete(runId);
        removed += 1;
      }
    }
    return removed;
  }

  clearLifecycle(_lifecycle: RunScratchLifecycle): number {
    const removed = this.#runs.size;
    this.#runs.clear();
    return removed;
  }

  #assertRunId(runId: string): void {
    if (runId.trim().length === 0) {
      throw new Error("RUN_ID_REQUIRED");
    }
  }

  #require(runId: string): MutableScratch<TBinding> {
    this.#assertRunId(runId);
    const run = this.#runs.get(runId);
    if (run === undefined) {
      throw new Error(`RUN_SCRATCH_NOT_FOUND:${runId}`);
    }
    if (run.expiresAt <= this.#now()) {
      this.#runs.delete(runId);
      throw new Error(`RUN_SCRATCH_EXPIRED:${runId}`);
    }
    return run;
  }

  #touch(run: MutableScratch<TBinding>): void {
    run.expiresAt = this.#now() + this.#ttlMs;
  }

  #snapshot(run: MutableScratch<TBinding>): RunScratchSnapshot<TBinding> {
    return {
      runId: run.runId,
      binding: run.binding,
      observations: [...run.observations.values()],
      remediationClaimed: run.remediationClaimed,
    };
  }
}
