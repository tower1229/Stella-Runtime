import type { TelegramConfirmationPluginApi } from "./confirmation.js";
import type { HostTransitionPort } from "../sync/index.js";
import type {
  OpenClawConsumptionApi,
  OpenClawRetrievalCommands,
} from "./consumption.js";

export interface CliCommand {
  command(name: string): CliCommand;
  description(value: string): CliCommand;
  requiredOption(flags: string, description: string): CliCommand;
  option(flags: string, description: string): CliCommand;
  action(
    handler: (options: Readonly<Record<string, unknown>>) => void | Promise<void>,
  ): CliCommand;
}

export interface CliDescriptor {
  readonly name: string;
  readonly description: string;
  readonly hasSubcommands: boolean;
}

export interface CognitiveRuntimePluginApi {
  readonly version?: string;
  readonly pluginConfig?: Readonly<Record<string, unknown>>;
  readonly runtime: {
    readonly version: string;
    readonly config?: OpenClawConsumptionApi["config"];
    readonly llm: {
      complete(params: unknown): Promise<unknown>;
    };
  };
  readonly logger?: {
    info(message: string): void;
    warn(message: string): void;
  };
  readonly lifecycle?: {
    registerRuntimeLifecycle(lifecycle: {
      readonly id: string;
      readonly description?: string;
      readonly cleanup?: (context: {
        readonly reason: "reset" | "delete" | "disable" | "restart";
        readonly sessionKey?: string;
        readonly runId?: string;
      }) => void | Promise<void>;
    }): void;
  };
  readonly on?: (event: PluginHookName, handler: PluginHookHandler) => void;
  readonly registerInteractiveHandler?: TelegramConfirmationPluginApi["registerInteractiveHandler"];
  readonly cognitiveRuntimeHostTransition?: HostTransitionPort;
  readonly cognitiveRuntimeRetrievalCommands?: OpenClawRetrievalCommands;
  registerCli(
    registrar: (context: { program: CliCommand }) => void | Promise<void>,
    options: { readonly descriptors: readonly CliDescriptor[] },
  ): void;
}

export type PluginHookName =
  | "before_prompt_build"
  | "after_tool_call"
  | "before_agent_finalize"
  | "agent_end";

export interface PluginHookContext {
  readonly runId?: string;
  readonly sessionKey?: string;
  readonly toolCallId?: string;
  readonly agentId?: string;
  readonly trigger?: string;
  readonly messageProvider?: string;
  readonly channelId?: string;
  readonly senderId?: string;
  readonly chatId?: string;
}

export type PluginHookHandler = (
  event: Readonly<Record<string, unknown>>,
  context: PluginHookContext,
) => unknown | Promise<unknown>;
