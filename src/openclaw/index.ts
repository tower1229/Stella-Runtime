import { runSelfCheck } from "../cli/index.js";
import {
  createRuntimeRecoveryPort,
  openRuntimeRecoverySnapshot,
} from "../recovery/index.js";
import type { RuntimeVerifyOptions } from "../recovery/index.js";
import type { CognitiveRuntimePluginApi } from "./plugin-api.js";

export { MemoryObservationAdapter } from "./ports.js";
export type {
  HostCapabilityManifest,
  MemoryObservation,
  MemoryObservationPort,
  MemoryToolResult,
} from "./ports.js";

interface RecoveryInstanceConfig {
  readonly authorityRevision: string;
  readonly hasServedRun: boolean;
}

interface RecoveryPluginConfig {
  readonly stateRoot: string;
  readonly instances: Readonly<Record<string, RecoveryInstanceConfig>>;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readStringOption = (
  options: Readonly<Record<string, unknown>>,
  name: string,
): string => {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`CLI_OPTION_REQUIRED:${name}`);
  }
  return value;
};

const requireJson = (options: Readonly<Record<string, unknown>>): void => {
  if (options.json !== true) {
    throw new Error("CLI_JSON_REQUIRED");
  }
};

const readRecoveryConfig = (
  pluginConfig: Readonly<Record<string, unknown>> | undefined,
): RecoveryPluginConfig => {
  const recovery = pluginConfig?.recovery;
  if (!isRecord(recovery) || typeof recovery.stateRoot !== "string") {
    throw new Error("RECOVERY_CONFIG_REQUIRED");
  }
  if (!isRecord(recovery.instances)) {
    throw new Error("RECOVERY_INSTANCES_REQUIRED");
  }
  const instances: Record<string, RecoveryInstanceConfig> = {};
  for (const [instanceId, value] of Object.entries(recovery.instances)) {
    if (
      !isRecord(value) ||
      typeof value.authorityRevision !== "string" ||
      typeof value.hasServedRun !== "boolean"
    ) {
      throw new Error(`RECOVERY_INSTANCE_CONFIG_INVALID:${instanceId}`);
    }
    instances[instanceId] = {
      authorityRevision: value.authorityRevision,
      hasServedRun: value.hasServedRun,
    };
  }
  return { stateRoot: recovery.stateRoot, instances };
};

const verifyOptions = (packageVersion: string): RuntimeVerifyOptions => ({
  supportedSnapshotSchemaVersions: [
    "cognitive-runtime.runtime-recovery-snapshot-manifest/v1",
  ],
  supportedStorageSchemaVersions: ["1"],
  supportedPackageVersions: [packageVersion],
  supportedContractVersions: ["v1"],
  access: "read_only",
});

const requireInstance = (
  config: RecoveryPluginConfig,
  instanceId: string,
): RecoveryInstanceConfig => {
  const instance = config.instances[instanceId];
  if (instance === undefined) {
    throw new Error(`RECOVERY_INSTANCE_NOT_CONFIGURED:${instanceId}`);
  }
  return instance;
};

const plugin = {
  id: "cognitive-runtime",
  name: "Stella Runtime",
  description: "Instance-neutral cognitive runtime for OpenClaw",
  register(api: CognitiveRuntimePluginApi): void {
    const packageVersion = api.version ?? "0.0.0";
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

        cognitive
          .command("backup")
          .description("Export an immutable authoritative Runtime snapshot")
          .requiredOption("--instance <id>", "Private Instance ID")
          .requiredOption("--output <dir>", "New snapshot directory")
          .option("--json", "Emit a machine-readable report")
          .action(async (options) => {
            requireJson(options);
            const config = readRecoveryConfig(api.pluginConfig);
            const instanceId = readStringOption(options, "instance");
            const instance = requireInstance(config, instanceId);
            const recovery = createRuntimeRecoveryPort({
              stateRoot: config.stateRoot,
              packageVersion,
              storageSchemaVersion: "1",
            });
            const snapshot = await recovery.backup({
              instanceId,
              authorityRevision: instance.authorityRevision,
              outputDirectory: readStringOption(options, "output"),
              consistency: "transactional_boundary",
            });
            console.log(JSON.stringify({
              operation: "backup",
              artifact_id: snapshot.artifactId,
              manifest: snapshot.manifest,
            }));
          });

        cognitive
          .command("verify")
          .description("Verify a Runtime snapshot without modifying it")
          .requiredOption("--snapshot <dir>", "Snapshot directory")
          .option("--json", "Emit a machine-readable report")
          .action(async (options) => {
            requireJson(options);
            const recovery = createRuntimeRecoveryPort({
              stateRoot: "",
              packageVersion,
              storageSchemaVersion: "1",
            });
            const snapshot = await openRuntimeRecoverySnapshot(
              readStringOption(options, "snapshot"),
            );
            console.log(JSON.stringify(
              await recovery.verify(snapshot, verifyOptions(packageVersion)),
            ));
          });

        cognitive
          .command("restore")
          .description("Restore authoritative Runtime state with rollback safety")
          .requiredOption("--instance <id>", "Private Instance ID")
          .requiredOption("--snapshot <dir>", "Snapshot directory")
          .option("--json", "Emit a machine-readable report")
          .action(async (options) => {
            requireJson(options);
            const config = readRecoveryConfig(api.pluginConfig);
            const instanceId = readStringOption(options, "instance");
            const instance = requireInstance(config, instanceId);
            const recovery = createRuntimeRecoveryPort({
              stateRoot: config.stateRoot,
              packageVersion,
              storageSchemaVersion: "1",
            });
            const snapshot = await openRuntimeRecoverySnapshot(
              readStringOption(options, "snapshot"),
            );
            console.log(JSON.stringify(await recovery.restore(snapshot, {
              targetInstanceId: instanceId,
              targetHasServedRun: instance.hasServedRun,
              restoreIdempotencyKey: `${instanceId}:${snapshot.artifactId}`,
              rollback: "required",
              supportedSnapshotSchemaVersions: [
                "cognitive-runtime.runtime-recovery-snapshot-manifest/v1",
              ],
              supportedStorageSchemaVersions: ["1"],
              supportedPackageVersions: [packageVersion],
              supportedContractVersions: ["v1"],
            })));
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
