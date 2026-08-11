export interface ReanswerPort<TClaim = unknown, TCompletion = unknown> {
  claim(correctionId: string): Promise<TClaim | null>;
  complete(claim: TClaim, completion: TCompletion): Promise<void>;
  release(claim: TClaim, reasonCode: string): Promise<void>;
}
