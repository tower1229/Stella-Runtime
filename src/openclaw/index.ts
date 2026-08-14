import { readFile } from "node:fs/promises";

import { runSelfCheck } from "../cli/index.js";
import type {
  CurrentStateEvent,
  StateCorrectionPreview,
  StateImportManifest,
} from "../contracts/index.js";
import {
  buildGeneration,
  showGeneration,
  validateAuthoritySource,
} from "../generation/index.js";
import type { BootstrapTarget } from "../generation/index.js";
import {
  createRuntimeVerifyOptions,
  createRuntimeRecoveryPort,
  openRuntimeRecoverySnapshot,
  recoverInterruptedRuntimeRestore,
  RUNTIME_RECOVERY_COMPATIBILITY,
} from "../recovery/index.js";
import {
  provenanceDatabasePath,
  SqliteProvenanceStore,
} from "../provenance/index.js";
import { markRuntimeInstanceRunServed } from "../state/index.js";
import {
  createExactStateImportPolicy,
  createStateManagementPort,
} from "../state/management.js";
import type { ExactStateImportAuthorization } from "../state/management.js";
import type { CognitiveRuntimePluginApi } from "./plugin-api.js";
import {
  openClawCandidateAdmissionService,
  registerTelegramConfirmationGateway,
} from "./confirmation.js";
import {
  readRuntimeConfig,
  registerRuntimeHooks,
  type RuntimeHookController,
} from "./runtime.js";

export { MemoryObservationAdapter } from "./ports.js";
export type {
  HostCapabilityManifest,
  MemoryObservation,
  MemoryObservationPort,
  MemoryToolResult,
} from "./ports.js";

interface RecoveryInstanceConfig {
  readonly authorityRevision: string;
}

interface RecoveryPluginConfig {
  readonly stateRoot: string;
  readonly activeInstanceId: string;
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

const readOptionalString = (
  options: Readonly<Record<string, unknown>>,
  name: string,
): string | undefined => {
  const value = options[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`CLI_OPTION_INVALID:${name}`);
  }
  return value;
};

const readOptionalInteger = (
  options: Readonly<Record<string, unknown>>,
  name: string,
): number | undefined => {
  const value = readOptionalString(options, name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`CLI_OPTION_INVALID:${name}`);
  }
  return parsed;
};

const readBootstrapTargets = (
  options: Readonly<Record<string, unknown>>,
): readonly BootstrapTarget[] => {
  const value = readOptionalString(options, "bootstrap");
  if (value === undefined) {
    return [];
  }
  const targets = value.split(",");
  if (targets.some((target) => target !== "USER.md" && target !== "MEMORY.md")) {
    throw new Error("CLI_OPTION_INVALID:bootstrap");
  }
  return targets as readonly BootstrapTarget[];
};

const readJsonFile = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf8")) as T;

const readStateImportAuthorization = async (path: string): Promise<{
  readonly authorizations: readonly ExactStateImportAuthorization[];
  readonly maxAuthorizationAgeMs: number;
}> => {
  const artifact = await readJsonFile<unknown>(path);
  if (!isRecord(artifact) || !Array.isArray(artifact.authorizations) ||
    typeof artifact.max_authorization_age_ms !== "number") {
    throw new Error("STATE_IMPORT_AUTHORIZATION_INVALID");
  }
  const authorizations = artifact.authorizations.map((item) => {
    if (!isRecord(item) || typeof item.eventId !== "string" ||
      typeof item.eventChecksum !== "string" ||
      (item.sourceKind !== "user_confirmed" && item.sourceKind !== "independently_verified") ||
      typeof item.sourceRef !== "string" || typeof item.verification !== "string" ||
      typeof item.verifiedAt !== "string") {
      throw new Error("STATE_IMPORT_AUTHORIZATION_INVALID");
    }
    return {
      eventId: item.eventId,
      eventChecksum: item.eventChecksum,
      sourceKind: item.sourceKind,
      sourceRef: item.sourceRef,
      verification: item.verification,
      verifiedAt: item.verifiedAt,
    } satisfies ExactStateImportAuthorization;
  });
  return {
    authorizations,
    maxAuthorizationAgeMs: artifact.max_authorization_age_ms,
  };
};

const readRecoveryConfig = (
  pluginConfig: Readonly<Record<string, unknown>> | undefined,
): RecoveryPluginConfig => {
  const recovery = pluginConfig?.recovery;
  if (
    !isRecord(recovery) ||
    typeof recovery.stateRoot !== "string" ||
    typeof recovery.activeInstanceId !== "string"
  ) {
    throw new Error("RECOVERY_CONFIG_REQUIRED");
  }
  if (!isRecord(recovery.instances)) {
    throw new Error("RECOVERY_INSTANCES_REQUIRED");
  }
  const instances: Record<string, RecoveryInstanceConfig> = {};
  for (const [instanceId, value] of Object.entries(recovery.instances)) {
    if (
      !isRecord(value) ||
      typeof value.authorityRevision !== "string"
    ) {
      throw new Error(`RECOVERY_INSTANCE_CONFIG_INVALID:${instanceId}`);
    }
    instances[instanceId] = {
      authorityRevision: value.authorityRevision,
    };
  }
  if (instances[recovery.activeInstanceId] === undefined) {
    throw new Error("RECOVERY_ACTIVE_INSTANCE_NOT_CONFIGURED");
  }
  return {
    stateRoot: recovery.stateRoot,
    activeInstanceId: recovery.activeInstanceId,
    instances,
  };
};

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
    if (api.registerInteractiveHandler !== undefined) {
      registerTelegramConfirmationGateway({
        api: { registerInteractiveHandler: api.registerInteractiveHandler },
        service: openClawCandidateAdmissionService,
        hostVersion: api.runtime.version,
      });
    }
    const runtimeConfig = readRuntimeConfig(api.pluginConfig);
    let runtimeController: RuntimeHookController | null = null;
    if (runtimeConfig !== null) {
      const recoveryConfig = api.pluginConfig?.recovery === undefined
        ? null
        : readRecoveryConfig(api.pluginConfig);
      runtimeController = registerRuntimeHooks(api, runtimeConfig, {
        ...(recoveryConfig === null ? {} : {
          recordProvenance: async (overlay) => {
            const store = new SqliteProvenanceStore({
              databasePath: provenanceDatabasePath(
                recoveryConfig.stateRoot,
                recoveryConfig.activeInstanceId,
              ),
            });
            try {
              await store.record(overlay);
            } finally {
              store.close();
            }
          },
        }),
      });
      if (runtimeController !== null) {
        api.lifecycle?.registerRuntimeLifecycle({
          id: "cognitive-runtime-run-scratch",
          description: "Clear bounded cognitive Runtime state.",
          cleanup: ({ reason }) => {
            runtimeController?.clearLifecycle(
              reason === "delete" ? "reset" : reason,
            );
          },
        });
      }
    }
    if (api.on !== undefined && api.pluginConfig?.recovery !== undefined) {
      const recoveryConfig = readRecoveryConfig(api.pluginConfig);
      api.on("before_prompt_build", async (_event, context) => {
        if (context.runId === undefined || context.runId.length === 0) {
          return;
        }
        if (
          await recoverInterruptedRuntimeRestore({
            stateRoot: recoveryConfig.stateRoot,
            instanceId: recoveryConfig.activeInstanceId,
          })
        ) {
          throw new Error("INTERRUPTED_RESTORE_ROLLED_BACK_RETRY_RUN");
        }
        markRuntimeInstanceRunServed({
          stateRoot: recoveryConfig.stateRoot,
          instanceId: recoveryConfig.activeInstanceId,
          runId: context.runId,
        });
      });
    }
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
          .command("metrics")
          .description("Read bounded cognitive runtime metrics")
          .option("--json", "Emit a machine-readable result")
          .action((options) => {
            requireJson(options);
            console.log(JSON.stringify({
              operation: "metrics",
              metrics: runtimeController?.metrics() ?? null,
            }));
          });

        cognitive
          .command("validate")
          .description("Validate one exact clean Authority Source Revision without mutation")
          .requiredOption("--authority <path>", "Authority Repository directory")
          .requiredOption("--revision <revision>", "Authority source revision")
          .option("--json", "Emit a machine-readable result")
          .action(async (options) => {
            requireJson(options);
            const result = await validateAuthoritySource({
              authorityDirectory: readStringOption(options, "authority"),
              sourceRevision: readStringOption(options, "revision"),
            });
            console.log(JSON.stringify({
              operation: "validate",
              source_revision: result.sourceRevision,
              record_count: result.recordCount,
              active_governing_system: result.activeGoverningSystem,
            }));
          });

        cognitive
          .command("build")
          .description("Build or reuse one immutable Generation without activating it")
          .requiredOption("--authority <path>", "Authority Repository directory")
          .requiredOption("--state <path>", "Generation state directory")
          .requiredOption("--revision <revision>", "Authority source revision")
          .option("--bootstrap <targets>", "Optional comma-separated USER.md,MEMORY.md projections")
          .option("--json", "Emit a machine-readable result")
          .action(async (options) => {
            requireJson(options);
            const result = await buildGeneration({
              authorityDirectory: readStringOption(options, "authority"),
              stateDirectory: readStringOption(options, "state"),
              sourceRevision: readStringOption(options, "revision"),
              packageVersion,
              bootstrapTargets: readBootstrapTargets(options),
            });
            console.log(JSON.stringify({
              operation: "build",
              package_version: result.manifest.package_version,
              source_revision: result.manifest.source_revision,
              sync_generation: result.syncGeneration,
              generation_directory: result.generationDirectory,
              reused: result.reused,
              bootstrap_projections: result.bootstrapProjections,
            }));
          });

        const generation = cognitive
          .command("generation")
          .description("Inspect immutable Generations");

        generation
          .command("show")
          .description("Show one built Generation without implying activation")
          .requiredOption("--state <path>", "Generation state directory")
          .requiredOption("--generation <id>", "Generation identity")
          .option("--json", "Emit a machine-readable result")
          .action(async (options) => {
            requireJson(options);
            const result = await showGeneration({
              stateDirectory: readStringOption(options, "state"),
              syncGeneration: readStringOption(options, "generation"),
            });
            console.log(JSON.stringify({
              operation: "generation_show",
              sync_generation: result.syncGeneration,
              source_revision: result.sourceRevision,
              active: result.active,
              active_generation: result.activeGeneration,
              active_source_revision: result.activeSourceRevision,
            }));
          });

        const state = cognitive
          .command("state")
          .description("Manage Current State through explicit domain operations");

        state
          .command("initialize")
          .description("Explicitly initialize an empty Current State Head")
          .requiredOption("--instance <id>", "Private Instance ID")
          .option("--json", "Emit a machine-readable result")
          .action(async (options) => {
            requireJson(options);
            const config = readRecoveryConfig(api.pluginConfig);
            const instanceId = readStringOption(options, "instance");
            requireInstance(config, instanceId);
            const port = createStateManagementPort({
              stateRoot: config.stateRoot,
              instanceId,
            });
            try {
              console.log(JSON.stringify({
                operation: "state_initialize",
                ...await port.initialize(),
              }));
            } finally {
              port.close();
            }
          });

        state
          .command("import")
          .description("Atomically import one checksummed baseline manifest")
          .requiredOption("--instance <id>", "Private Instance ID")
          .requiredOption("--manifest <path>", "State Import Manifest JSON")
          .requiredOption("--authorization <path>", "Fresh exact import authorization JSON")
          .option("--json", "Emit a machine-readable result")
          .action(async (options) => {
            requireJson(options);
            const config = readRecoveryConfig(api.pluginConfig);
            const instanceId = readStringOption(options, "instance");
            requireInstance(config, instanceId);
            const port = createStateManagementPort({ stateRoot: config.stateRoot, instanceId });
            try {
              const manifest = await readJsonFile<StateImportManifest>(
                readStringOption(options, "manifest"),
              );
              const authorization = await readStateImportAuthorization(
                readStringOption(options, "authorization"),
              );
              console.log(JSON.stringify({
                operation: "state_import",
                ...await port.import(manifest, {
                  policy: createExactStateImportPolicy({
                    ...authorization,
                    now: () => new Date().toISOString(),
                  }),
                }),
              }));
            } finally {
              port.close();
            }
          });

        state
          .command("view")
          .description("Read an immutable Current State View")
          .requiredOption("--instance <id>", "Private Instance ID")
          .option("--revision <number>", "Event boundary revision")
          .option("--json", "Emit a machine-readable result")
          .action(async (options) => {
            requireJson(options);
            const config = readRecoveryConfig(api.pluginConfig);
            const instanceId = readStringOption(options, "instance");
            requireInstance(config, instanceId);
            const port = createStateManagementPort({ stateRoot: config.stateRoot, instanceId });
            try {
              const revision = readOptionalInteger(options, "revision");
              console.log(JSON.stringify({
                operation: "state_view",
                view: await port.view(revision === undefined ? {} : { revision }),
              }));
            } finally {
              port.close();
            }
          });

        const correct = state
          .command("correct")
          .description("Plan or apply one exact State Correction");

        correct
          .command("plan")
          .description("Render an exact State Correction Preview")
          .requiredOption("--instance <id>", "Private Instance ID")
          .requiredOption("--preview <id>", "Stable Preview ID")
          .requiredOption("--event <path>", "Proposed Current State Event JSON")
          .requiredOption("--expires <instant>", "Preview expiry instant")
          .option("--json", "Emit a machine-readable result")
          .action(async (options) => {
            requireJson(options);
            const config = readRecoveryConfig(api.pluginConfig);
            const instanceId = readStringOption(options, "instance");
            requireInstance(config, instanceId);
            const port = createStateManagementPort({ stateRoot: config.stateRoot, instanceId });
            try {
              console.log(JSON.stringify({
                operation: "state_correct_plan",
                preview: await port.planCorrection({
                  previewId: readStringOption(options, "preview"),
                  event: await readJsonFile<CurrentStateEvent>(readStringOption(options, "event")),
                  expiresAt: readStringOption(options, "expires"),
                }),
              }));
            } finally {
              port.close();
            }
          });

        correct
          .command("apply")
          .description("Apply a Preview by exact checksum and unchanged base View")
          .requiredOption("--instance <id>", "Private Instance ID")
          .requiredOption("--preview <path>", "State Correction Preview JSON")
          .requiredOption("--checksum <checksum>", "Exact Preview checksum")
          .requiredOption("--correction <id>", "Correction ID")
          .requiredOption("--session <checksum>", "Session key hash")
          .requiredOption("--prior-run <id>", "Prior Run ID")
          .requiredOption("--idempotency-key <key>", "Outbox idempotency key")
          .option("--json", "Emit a machine-readable result")
          .action(async (options) => {
            requireJson(options);
            const config = readRecoveryConfig(api.pluginConfig);
            const instanceId = readStringOption(options, "instance");
            requireInstance(config, instanceId);
            const port = createStateManagementPort({ stateRoot: config.stateRoot, instanceId });
            try {
              console.log(JSON.stringify({
                operation: "state_correct_apply",
                ...await port.applyCorrection({
                  preview: await readJsonFile<StateCorrectionPreview>(readStringOption(options, "preview")),
                  previewChecksum: readStringOption(options, "checksum"),
                  correctionId: readStringOption(options, "correction"),
                  sessionKeyHash: readStringOption(options, "session"),
                  priorRunId: readStringOption(options, "priorRun"),
                  outboxIdempotencyKey: readStringOption(options, "idempotencyKey"),
                }),
              }));
            } finally {
              port.close();
            }
          });

        const trace = cognitive
          .command("trace")
          .description("Read Cognitive Provenance Overlay records");

        trace
          .command("get")
          .description("Get one Cognitive Provenance Overlay")
          .requiredOption("--instance <id>", "Private Instance ID")
          .requiredOption("--trace <id>", "Trace ID")
          .option("--json", "Emit a machine-readable result")
          .action(async (options) => {
            requireJson(options);
            const config = readRecoveryConfig(api.pluginConfig);
            const instanceId = readStringOption(options, "instance");
            requireInstance(config, instanceId);
            const store = new SqliteProvenanceStore({
              databasePath: provenanceDatabasePath(config.stateRoot, instanceId),
              readOnly: true,
            });
            try {
              console.log(JSON.stringify({
                operation: "trace_get",
                trace: await store.get(readStringOption(options, "trace")),
              }));
            } finally {
              store.close();
            }
          });

        trace
          .command("query")
          .description("Query Cognitive Provenance Overlay records")
          .requiredOption("--instance <id>", "Private Instance ID")
          .option("--run <id>", "Run ID")
          .option("--session <hash>", "Session key hash")
          .option("--status <status>", "Trace status")
          .option("--ref <id>", "Stable reference ID")
          .option("--limit <number>", "Maximum result count")
          .option("--json", "Emit a machine-readable result")
          .action(async (options) => {
            requireJson(options);
            const config = readRecoveryConfig(api.pluginConfig);
            const instanceId = readStringOption(options, "instance");
            requireInstance(config, instanceId);
            const store = new SqliteProvenanceStore({
              databasePath: provenanceDatabasePath(config.stateRoot, instanceId),
              readOnly: true,
            });
            try {
              const runId = readOptionalString(options, "run");
              const sessionKeyHash = readOptionalString(options, "session");
              const traceStatus = readOptionalString(options, "status");
              const stableRef = readOptionalString(options, "ref");
              const limit = readOptionalInteger(options, "limit");
              console.log(JSON.stringify({
                operation: "trace_query",
                traces: await store.query({
                  ...(runId === undefined ? {} : { runId }),
                  ...(sessionKeyHash === undefined ? {} : { sessionKeyHash }),
                  ...(traceStatus === undefined ? {} : { traceStatus }),
                  ...(stableRef === undefined ? {} : { stableRef }),
                  ...(limit === undefined ? {} : { limit }),
                }),
              }));
            } finally {
              store.close();
            }
          });

        cognitive
          .command("backup")
          .description("Export an immutable Runtime Recovery Snapshot")
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
              storageSchemaVersion:
                RUNTIME_RECOVERY_COMPATIBILITY.currentStorageSchemaVersion,
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
              storageSchemaVersion:
                RUNTIME_RECOVERY_COMPATIBILITY.currentStorageSchemaVersion,
            });
            const snapshot = await openRuntimeRecoverySnapshot(
              readStringOption(options, "snapshot"),
            );
            console.log(JSON.stringify(
              await recovery.verify(
                snapshot,
                createRuntimeVerifyOptions(packageVersion),
              ),
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
              storageSchemaVersion:
                RUNTIME_RECOVERY_COMPATIBILITY.currentStorageSchemaVersion,
            });
            const snapshot = await openRuntimeRecoverySnapshot(
              readStringOption(options, "snapshot"),
            );
            console.log(JSON.stringify(await recovery.restore(snapshot, {
              targetInstanceId: instanceId,
              restoreIdempotencyKey: `${instanceId}:${snapshot.artifactId}`,
              rollback: "required",
              ...createRuntimeVerifyOptions(packageVersion),
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
