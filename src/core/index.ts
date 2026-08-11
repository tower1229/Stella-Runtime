export interface RunScratchPort<
  TBinding = unknown,
  TObservation = unknown,
  TRemediationClaim = unknown,
> {
  acquire(runId: string): Promise<TBinding>;
  observe(runId: string, observation: TObservation): Promise<void>;
  claimRemediation(runId: string): Promise<TRemediationClaim>;
  release(runId: string): Promise<void>;
}
