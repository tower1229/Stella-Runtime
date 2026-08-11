export interface MemoryObservationPort<
  TToolResult = unknown,
  TObservation = unknown,
> {
  observe(toolResult: TToolResult): TObservation | null;
}
