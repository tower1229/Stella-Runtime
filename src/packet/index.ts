export interface RemediationPort<TRequest = unknown, TResult = unknown> {
  remediate(request: TRequest): Promise<TResult>;
}

export interface RemediationRequest {
  readonly runId: string;
  readonly expectedRevision: number;
}

export interface RemediationCasResult {
  readonly applied: boolean;
  readonly revision: number;
}

export type RemediationOutcome =
  | { readonly status: "applied"; readonly revision: number }
  | { readonly status: "revision_conflict"; readonly revision: number }
  | { readonly status: "already_claimed"; readonly revision: null };

export interface CompareAndSetRemediationOptions {
  readonly scratch: {
    claimRemediation(runId: string): Promise<boolean>;
  };
  readonly compareAndSet: (
    request: RemediationRequest,
  ) => Promise<RemediationCasResult>;
}

export class CompareAndSetRemediation
  implements RemediationPort<RemediationRequest, RemediationOutcome>
{
  readonly #scratch: CompareAndSetRemediationOptions["scratch"];
  readonly #compareAndSet: CompareAndSetRemediationOptions["compareAndSet"];

  constructor(options: CompareAndSetRemediationOptions) {
    this.#scratch = options.scratch;
    this.#compareAndSet = options.compareAndSet;
  }

  async remediate(request: RemediationRequest): Promise<RemediationOutcome> {
    if (!(await this.#scratch.claimRemediation(request.runId))) {
      return { status: "already_claimed", revision: null };
    }
    const result = await this.#compareAndSet(request);
    return result.applied
      ? { status: "applied", revision: result.revision }
      : { status: "revision_conflict", revision: result.revision };
  }
}
