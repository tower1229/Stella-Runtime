import { runSelfCheck } from "../cli/index.js";
import type { CognitiveRuntimePluginApi } from "./plugin-api.js";

export { MemoryObservationAdapter } from "./ports.js";
export type {
  HostCapabilityManifest,
  MemoryObservation,
  MemoryObservationPort,
  MemoryToolResult,
} from "./ports.js";

const plugin = {
  id: "cognitive-runtime",
  name: "Stella Runtime",
  description: "Instance-neutral cognitive runtime for OpenClaw",
  register(api: CognitiveRuntimePluginApi): void {
    api.registerCli(
      ({ program }) => {
        const cognitive = program
          .command("cognitive")
          .description("Inspect the cognitive runtime");

        cognitive
          .command("self-check")
          .description("Check whether the cognitive runtime is available")
          .action(() => {
            console.log(JSON.stringify({
              ...runSelfCheck(),
              hostCapabilities: {
                hostModelCompletion:
                  typeof api.runtime.llm.complete === "function"
                    ? "llm.complete"
                    : "unavailable",
              },
            }));
          });
      },
      {
        descriptors: [
          {
            name: "cognitive",
            description: "Inspect the cognitive runtime",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
};

export default plugin;
