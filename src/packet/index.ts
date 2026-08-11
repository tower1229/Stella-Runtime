export interface RemediationPort<TRequest = unknown, TResult = unknown> {
  remediate(request: TRequest): Promise<TResult>;
}
