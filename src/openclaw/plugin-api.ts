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
    readonly llm: {
      complete(params: unknown): Promise<unknown>;
    };
  };
  registerCli(
    registrar: (context: { program: CliCommand }) => void | Promise<void>,
    options: { readonly descriptors: readonly CliDescriptor[] },
  ): void;
}
