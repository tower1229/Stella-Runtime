export interface RouterPort<TRequest = unknown, TResult = unknown> {
  route(request: TRequest): Promise<TResult>;
}
