export interface CliCommand {
  command(name: string): CliCommand;
  description(value: string): CliCommand;
  action(handler: () => void | Promise<void>): CliCommand;
}

export interface CliDescriptor {
  readonly name: string;
  readonly description: string;
  readonly hasSubcommands: boolean;
}

export interface CognitiveRuntimePluginApi {
  registerCli(
    registrar: (context: { program: CliCommand }) => void | Promise<void>,
    options: { readonly descriptors: readonly CliDescriptor[] },
  ): void;
}
