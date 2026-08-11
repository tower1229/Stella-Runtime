export interface SelfCheckResult {
  readonly status: "ok";
  readonly pluginId: "cognitive-runtime";
}

export function runSelfCheck(): SelfCheckResult {
  return {
    status: "ok",
    pluginId: "cognitive-runtime",
  };
}
