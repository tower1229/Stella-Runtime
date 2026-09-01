import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { runSelfCheck } from "../cli/index.js";
import { resolveCompatibilityMatrixRow } from "../compatibility/index.js";
import type {
  CurrentStateEvent,
  InstanceCutoverPlan,
  StateCorrectionPreview,
  StateImportManifest,
} from "../contracts/index.js";
import {
  buildGeneration,
  generationDomainIdentity,
  loadGenerationDomainIndexes,
  showGeneration,
  validateAuthoritySource,
} from "../generation/index.js";
import type {
  BootstrapTarget,
  GenerationDomainIdentity,
  GenerationDomainProjectionInput,
} from "../generation/index.js";
import {
  FileProjectionExchange,
  resolvePersonalDataLocator,
} from "../personal-data/index.js";
import {
  FileBindingCompiler,
  validateGenerationDomainsCurrent,
} from "../runtime/binding.js";
import {
  inspectStoredGenerationStatus,
  loadActiveGenerationHealth,
  readLatestAuthorityRevision,
  RuntimeHealthMonitor,
  validateActiveReceipt,
} from "../diagnostics/index.js";
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
import {
  expectedHostDomainEvidenceFromReceipt,
  recoverInterruptedSync,
  syncGeneration,
} from "../sync/index.js";
import type { CognitiveRuntimePluginApi } from "./plugin-api.js";
import {
  OpenClawCliRetrievalCommands,
  OpenClawGenerationConsumptionAdapter,
} from "./consumption.js";
import {
  openClawCandidateAdmissionService,
  configureOpenClawCandidateAdmissionPersistence,
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

const packageMetadata: unknown = createRequire(import.meta.url)("../../package.json");
if (
  typeof packageMetadata !== "object" ||
  packageMetadata === null ||
  !("version" in packageMetadata) ||
  typeof packageMetadata.version !== "string" ||
  packageMetadata.version.length === 0
) {
  throw new Error("RUNTIME_PACKAGE_VERSION_INVALID");
}
export const RUNTIME_PACKAGE_VERSION = packageMetadata.version;

export interface CognitiveRuntimeOpenClawComposition {
  readonly cutoverPublication?: NonNullable<
    CognitiveRuntimePluginApi["cognitiveRuntimeCutoverPublication"]
  >;
  readonly publicCorpus?: NonNullable<
    CognitiveRuntimePluginApi["cognitiveRuntimePublicCorpus"]
  >;
  readonly publicCorpusHealth?: NonNullable<
    CognitiveRuntimePluginApi["cognitiveRuntimePublicCorpusHealth"]
  >;
  readonly instanceCutover?: NonNullable<
    CognitiveRuntimePluginApi["cognitiveRuntimeInstanceCutover"]
  >;
}

export type CognitiveRuntimeOpenClawCompositionProvider =
  | CognitiveRuntimeOpenClawComposition
  | ((hostApi: CognitiveRuntimePluginApi) => CognitiveRuntimeOpenClawComposition);

const composePluginApi = (
  hostApi: CognitiveRuntimePluginApi,
  composition: CognitiveRuntimeOpenClawComposition,
): CognitiveRuntimePluginApi => {
  const overrides = new Map<PropertyKey, unknown>();
  overrides.set("version", RUNTIME_PACKAGE_VERSION);
  if (composition.cutoverPublication !== undefined) {
    overrides.set(
      "cognitiveRuntimeCutoverPublication",
      composition.cutoverPublication,
    );
  }
  if (composition.publicCorpus !== undefined) {
    overrides.set("cognitiveRuntimePublicCorpus", composition.publicCorpus);
  }
  if (composition.publicCorpusHealth !== undefined) {
    overrides.set(
      "cognitiveRuntimePublicCorpusHealth",
      composition.publicCorpusHealth,
    );
  }
  if (composition.instanceCutover !== undefined) {
    overrides.set(
      "cognitiveRuntimeInstanceCutover",
      composition.instanceCutover,
    );
  }
  return new Proxy(hostApi, {
    get(target, property) {
      if (overrides.has(property)) return overrides.get(property);
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

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

const hasStellaLocator = (apiConfig: unknown): boolean => {
  if (!isRecord(apiConfig)) return false;
  const plugins = apiConfig.plugins;
  if (!isRecord(plugins) || !isRecord(plugins.entries)) return false;
  const entry = plugins.entries["cognitive-runtime"];
  return isRecord(entry) && isRecord(entry.config) && entry.config.stella !== undefined;
};

const execFileAsync = promisify(execFile);

const callGatewaySync = async (
  sourceRevision: string,
  cutoverPlanPath?: string,
): Promise<Readonly<Record<string, unknown>>> => {
  const configuredBinary = process.env.OPENCLAW_BIN;
  const command = configuredBinary ?? process.execPath;
  const arguments_ = configuredBinary === undefined
    ? [process.argv[1] ?? "", "gateway", "call", "cognitive-runtime.sync"]
    : ["gateway", "call", "cognitive-runtime.sync"];
  arguments_.push(
    "--json",
    "--timeout",
    "120000",
    "--params",
    JSON.stringify({
      sourceRevision,
      ...(cutoverPlanPath === undefined ? {} : { cutoverPlanPath }),
    }),
  );
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(command, arguments_, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (error: unknown) {
    const details = isRecord(error)
      ? [error.message, error.stdout, error.stderr]
          .filter((value): value is string => typeof value === "string")
          .join("\n")
      : String(error);
    throw new Error(`SYNC_GATEWAY_CALL_FAILED:${details}`);
  }
  const parsed = JSON.parse(stdout) as unknown;
  const result = isRecord(parsed) && isRecord(parsed.result) ? parsed.result : parsed;
  if (!isRecord(result)) throw new Error("SYNC_GATEWAY_RESPONSE_INVALID");
  return result;
};

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

export const createCognitiveRuntimeOpenClawPlugin = (
  compositionProvider: CognitiveRuntimeOpenClawCompositionProvider = {},
) => ({
  id: "cognitive-runtime",
  name: "Stella Runtime",
  description: "Instance-neutral cognitive runtime for OpenClaw",
  register(hostApi: CognitiveRuntimePluginApi): void {
    const composition = typeof compositionProvider === "function"
      ? compositionProvider(hostApi)
      : compositionProvider;
    const api = composePluginApi(hostApi, composition);
    const packageVersion = RUNTIME_PACKAGE_VERSION;
    const runtimeConfig = readRuntimeConfig(api.pluginConfig);
    const readFitnessDomain = async (): Promise<GenerationDomainProjectionInput | null> => {
      if (runtimeConfig === null || api.runtime.config === undefined) return null;
      const apiConfig = api.runtime.config.current();
      if (!hasStellaLocator(apiConfig)) return null;
      const layout = await resolvePersonalDataLocator({
        apiConfig,
        runtimeInstanceId: runtimeConfig.instance_id,
      });
      let projection: GenerationDomainProjectionInput["projection"];
      try {
        projection = await new FileProjectionExchange({
          layout,
          instanceId: runtimeConfig.instance_id,
          ownerId: "runtime-generation-consumer",
        }).readStellaProjection("fitness_history");
      } catch (error: unknown) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return null;
        }
        throw error;
      }
      return { domainId: "fitness", projection };
    };
    const domainProjectionReader = {
      async read(domainId: string): Promise<GenerationDomainIdentity> {
        if (domainId !== "fitness") throw new Error("ACTIVE_DOMAIN_PROJECTION_UNAVAILABLE");
        const domain = await readFitnessDomain();
        if (domain === null) throw new Error("ACTIVE_DOMAIN_PROJECTION_UNAVAILABLE");
        return generationDomainIdentity(domain.domainId, domain.projection);
      },
    };
    if (runtimeConfig !== null) {
      configureOpenClawCandidateAdmissionPersistence(runtimeConfig.runtime_storage);
    }
    if (api.registerInteractiveHandler !== undefined) {
      registerTelegramConfirmationGateway({
        api: { registerInteractiveHandler: api.registerInteractiveHandler },
        service: openClawCandidateAdmissionService,
        hostVersion: api.runtime.version,
      });
    }
    let runtimeHooksRegistered = false;
    const hostTransition = runtimeConfig === null
      ? undefined
      : api.cognitiveRuntimeHostTransition ?? (
          api.runtime.config === undefined
            ? undefined
            : new OpenClawGenerationConsumptionAdapter(
                runtimeConfig,
                { config: api.runtime.config },
                api.cognitiveRuntimeRetrievalCommands ??
                  new OpenClawCliRetrievalCommands(),
                api.cognitiveRuntimeInstanceCutover,
              )
        );
    const healthMonitor = runtimeConfig === null || hostTransition === undefined
      ? null
      : new RuntimeHealthMonitor({
          config: runtimeConfig,
          hostVersion: api.runtime.version,
          nodeVersion: process.versions.node,
          pluginDiscovered: () => runtimeHooksRegistered,
          hostCapabilities: async () => {
            if (
              typeof api.runtime.llm.complete !== "function" ||
              api.runtime.config === undefined ||
              hostTransition === undefined
            ) return false;
            return isRecord(api.runtime.config.current());
          },
          authority: {
            validate: async () => {
              const sourceRevision = await readLatestAuthorityRevision(
                runtimeConfig.adapters.authority_checkout,
              );
              return validateAuthoritySource({
                authorityDirectory: runtimeConfig.adapters.authority_checkout,
                sourceRevision,
              });
            },
          },
          active: { load: () => loadActiveGenerationHealth(runtimeConfig) },
          configIdentity: {
            verify: async () => {
              const active = await loadActiveGenerationHealth(runtimeConfig);
              return validateActiveReceipt(
                active,
                runtimeConfig,
                api.runtime.version,
                process.versions.node,
              );
            },
          },
          retrieval: {
            verify: async (active) => {
              const projection = active.manifest.files.find((file) =>
                file.path === "projection-entries.json");
              if (projection === undefined) throw new Error("ACTIVE_PROJECTION_MISSING");
              const generationDirectory = join(
                runtimeConfig.generation_storage,
                active.pointer.generation_id,
              );
              const expectedDomainEvidence =
                expectedHostDomainEvidenceFromReceipt(active.receipt);
              await hostTransition.verifyTarget({
                config: runtimeConfig,
                sourceRevision: active.pointer.source_revision,
                syncGeneration: active.pointer.generation_id,
                generationDirectory,
                projectionDirectory: join(
                  runtimeConfig.generation_storage,
                  active.pointer.generation_id,
                  "projections",
                  active.pointer.generation_id,
                ),
                manifestChecksum: active.pointer.manifest_checksum,
                projectionChecksum: projection.checksum,
                hostConfigChecksum: active.receipt.host_config_checksum,
                domainIndexes: await loadGenerationDomainIndexes(generationDirectory),
                previousDomainIndexes: [],
                expectedIndexEvidence: {
                  searchSentinelChecksum:
                    active.receipt.index_evidence.search_sentinel_checksum,
                  getSentinelChecksum:
                    active.receipt.index_evidence.get_sentinel_checksum,
                },
                ...(expectedDomainEvidence.length === 0
                  ? {}
                  : { expectedDomainEvidence }),
              });
            },
          },
          domainProjection: {
            verify: async (active) => {
              if (
                active.manifest.schema_version
                !== "cognitive-runtime.generation-manifest/v3"
              ) return;
              await validateGenerationDomainsCurrent(
                active.manifest.domains,
                domainProjectionReader,
              );
            },
          },
          ...(api.cognitiveRuntimePublicCorpusHealth === undefined ? {} : {
            publicCorpus: api.cognitiveRuntimePublicCorpusHealth,
          }),
        });
    const stopPeriodicHealth = healthMonitor?.startPeriodic(5 * 60 * 1000);
    const disposeCandidateLifecycle = healthMonitor === null || runtimeConfig === null
      ? undefined
      : openClawCandidateAdmissionService.setInstanceLifecycleObserver(
          runtimeConfig.instance_id,
          healthMonitor,
        );
    let runtimeController: RuntimeHookController | null = null;
    if (runtimeConfig !== null) {
      runtimeController = registerRuntimeHooks(api, runtimeConfig, {
        bindingCompiler: new FileBindingCompiler({ domainProjectionReader }),
        ...(healthMonitor === null ? {} : { healthGate: healthMonitor }),
        recordProvenance: async (overlay) => {
          const store = new SqliteProvenanceStore({
            databasePath: provenanceDatabasePath(
              runtimeConfig.runtime_storage,
              runtimeConfig.instance_id,
            ),
          });
          try {
            await store.record(overlay);
          } finally {
            store.close();
          }
        },
      });
      runtimeHooksRegistered = runtimeController !== null;
      if (runtimeController !== null) {
        api.lifecycle?.registerRuntimeLifecycle({
          id: "cognitive-runtime-run-scratch",
          description: "Clear bounded cognitive Runtime state.",
          cleanup: ({ reason }) => {
            stopPeriodicHealth?.();
            disposeCandidateLifecycle?.();
            runtimeController?.clearLifecycle(
              reason === "delete" ? "reset" : reason,
            );
          },
        });
      }
    }
    if (
      runtimeConfig !== null &&
      runtimeController !== null &&
      hostTransition !== undefined
    ) {
      void recoverInterruptedSync({
          config: runtimeConfig,
          hostVersion: api.runtime.version,
          nodeVersion: process.versions.node,
          host: hostTransition,
          runs: runtimeController,
          domainProjectionReader,
          ...(healthMonitor === null ? {} : { lifecycle: healthMonitor }),
        }).then(async () => {
          await healthMonitor?.reconcile("startup");
        }).catch((error: unknown) => {
        runtimeController.closeAdmission("startup-recovery-failed");
        api.logger?.warn(JSON.stringify({
          component: "cognitive-runtime",
          reasonCode: error instanceof Error
            ? error.message.split(":", 1)[0]
            : "SYNC_RECOVERY_FAILED",
        }));
      });
    }
    const performSync = async (
      sourceRevision: string,
      cutoverPlan?: InstanceCutoverPlan,
    ) => {
      if (
        runtimeConfig === null ||
        runtimeController === null ||
        hostTransition === undefined
      ) {
        throw new Error("SYNC_RUNTIME_PORTS_REQUIRED");
      }
      const result = await syncGeneration({
        config: runtimeConfig,
        sourceRevision,
        packageVersion,
        hostVersion: api.runtime.version,
        nodeVersion: process.versions.node,
        host: hostTransition,
        runs: runtimeController,
        domainProjectionReader,
        ...await (async () => {
          const domain = await readFitnessDomain();
          return domain === null ? {} : { domainProjections: [domain] };
        })(),
        ...(healthMonitor === null ? {} : { lifecycle: healthMonitor }),
        ...(cutoverPlan === undefined ? {} : {
          cutover: {
            plan: cutoverPlan,
            ...(api.cognitiveRuntimeCutoverPublication === undefined ? {} : {
              publication: api.cognitiveRuntimeCutoverPublication,
            }),
            ...(api.cognitiveRuntimePublicCorpus === undefined ? {} : {
              publicCorpus: api.cognitiveRuntimePublicCorpus,
            }),
          },
        }),
      });
      await healthMonitor?.reconcile("sync");
      return {
        package_version: packageVersion,
        source_revision: result.sourceRevision,
        sync_generation: result.syncGeneration,
        reused_generation: result.reusedGeneration,
        receipt_path: result.receiptPath,
        pointer_path: result.pointerPath,
        ...(cutoverPlan === undefined ? {} : {
          cutover_plan_checksum: cutoverPlan.checksum,
        }),
      };
    };
    api.registerGatewayMethod?.(
      "cognitive-runtime.sync",
      async ({ params, respond }) => {
        try {
          const sourceRevision = params.sourceRevision;
          if (typeof sourceRevision !== "string" || sourceRevision.length === 0) {
            throw new Error("SOURCE_REVISION_REQUIRED");
          }
          const cutoverPlanPath = params.cutoverPlanPath;
          if (cutoverPlanPath !== undefined && typeof cutoverPlanPath !== "string") {
            throw new Error("CUTOVER_PLAN_PATH_INVALID");
          }
          const cutoverPlan = cutoverPlanPath === undefined
            ? undefined
            : await readJsonFile<InstanceCutoverPlan>(cutoverPlanPath);
          respond(true, await performSync(
            sourceRevision,
            cutoverPlan,
          ));
        } catch (error: unknown) {
          respond(false, undefined, {
            code: "COGNITIVE_SYNC_FAILED",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
      { scope: "operator.admin" },
    );
    api.registerGatewayMethod?.(
      "cognitive-runtime.reconcile",
      async ({ respond }) => {
        try {
          if (healthMonitor === null) throw new Error("RUNTIME_HEALTH_UNAVAILABLE");
          respond(true, await healthMonitor.reconcile("detected_drift"));
        } catch (error: unknown) {
          respond(false, undefined, {
            code: "COGNITIVE_RECONCILIATION_FAILED",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
      { scope: "operator.admin" },
    );
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
          .action(async () => {
            if (healthMonitor !== null) {
              console.log(JSON.stringify({
                operation: "self_check",
                ...await healthMonitor.selfCheck(),
              }));
              return;
            }
            const hostCapabilities = {
              hostModelCompletion:
                typeof api.runtime.llm.complete === "function"
                  ? "llm.complete"
                  : "unavailable",
            };
            try {
              const matrixRow = await resolveCompatibilityMatrixRow({
                openclawVersion: api.runtime.version,
                nodeVersion: process.versions.node,
              });
              console.log(JSON.stringify({
                ...runSelfCheck(),
                compatibilityMatrixRow: matrixRow,
                hostCapabilities,
              }));
            } catch {
              console.log(JSON.stringify({
                status: "fail",
                pluginId: "cognitive-runtime",
                compatibilityMatrixRow: null,
                hostCapabilities,
                reasonCodes: ["INCOMPATIBLE_HOST"],
              }));
            }
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
              health: healthMonitor?.metrics() ?? null,
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

        cognitive
          .command("sync")
          .description("Synchronize one committed Authority target through the full Activation Barrier")
          .requiredOption("--revision <revision>", "Authority source revision")
          .option("--cutover-plan <path>", "Optional Instance Cutover Plan contract")
          .option("--json", "Emit a machine-readable result")
          .action(async (options) => {
            requireJson(options);
            const cutoverPlanPath = readOptionalString(options, "cutoverPlan");
            const result = api.registerGatewayMethod === undefined
              ? await performSync(
                  readStringOption(options, "revision"),
                  cutoverPlanPath === undefined
                    ? undefined
                    : await readJsonFile<InstanceCutoverPlan>(cutoverPlanPath),
                )
              : await callGatewaySync(
                  readStringOption(options, "revision"),
                  cutoverPlanPath === undefined ? undefined : resolve(cutoverPlanPath),
                );
            console.log(JSON.stringify({
              operation: "sync",
              ...result,
            }));
          });

        const generation = cognitive
          .command("generation")
          .description("Inspect immutable Generations");

        generation
          .command("show")
          .description("Show operational Generation status or one explicit built Generation")
          .option("--state <path>", "Generation state directory")
          .option("--generation <id>", "Generation identity")
          .option("--json", "Emit a machine-readable result")
          .action(async (options) => {
            requireJson(options);
            const stateDirectory = readOptionalString(options, "state");
            const generationId = readOptionalString(options, "generation");
            if (stateDirectory === undefined && generationId === undefined) {
              if (runtimeConfig === null) throw new Error("RUNTIME_CONFIG_REQUIRED");
              const latestSourceRevision = await readLatestAuthorityRevision(
                runtimeConfig.adapters.authority_checkout,
              );
              console.log(JSON.stringify({
                operation: "generation_show",
                ...await inspectStoredGenerationStatus({
                  config: runtimeConfig,
                  latestSourceRevision,
                  hostVersion: api.runtime.version,
                  nodeVersion: process.versions.node,
                }),
              }));
              return;
            }
            if (stateDirectory === undefined || generationId === undefined) {
              throw new Error("CLI_OPTIONS_REQUIRED_TOGETHER:state,generation");
            }
            const result = await showGeneration({
              stateDirectory,
              syncGeneration: generationId,
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
          .command("lifecycle")
          .description("Read bounded privacy-safe Runtime lifecycle outcomes")
          .option("--json", "Emit a machine-readable result")
          .action((options) => {
            requireJson(options);
            console.log(JSON.stringify({
              operation: "trace_lifecycle",
              traces: healthMonitor?.lifecycleTraces() ?? [],
            }));
          });

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
});

const plugin = createCognitiveRuntimeOpenClawPlugin();

export default plugin;
