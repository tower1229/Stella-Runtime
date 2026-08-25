import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { InstanceRuntimeConfig } from "../contracts/index.js";
import type { CutoverTarget } from "../cutover/index.js";
import { atomicWriteFile } from "../core/persistence.js";
import type {
  HostDomainIndexEvidence,
  HostIndexEvidence,
  HostSnapshot,
  HostTransitionPort,
  SyncTarget,
} from "../sync/index.js";

export const RETRIEVAL_PATH_OWNERSHIP_FILE = "retrieval-paths.json";
const OWNERSHIP_SCHEMA = "cognitive-runtime.retrieval-path-ownership/v1";

type JsonRecord = Record<string, unknown>;

interface OpenClawConfigPort {
  current(): Readonly<Record<string, unknown>>;
  mutateConfigFile(input: {
    readonly afterWrite: { readonly mode: "auto" };
    readonly mutate: (draft: JsonRecord) => void | Promise<void>;
  }): Promise<unknown>;
}

export interface OpenClawConsumptionApi {
  readonly config: OpenClawConfigPort;
}

export interface OpenClawRetrievalCommands {
  index(agentId: string): Promise<void>;
  status(agentId: string): Promise<unknown>;
  search(agentId: string, query: string): Promise<unknown>;
  get(agentId: string, path: string): Promise<unknown>;
}

export type OpenClawCommandRunner = (arguments_: readonly string[]) => Promise<string>;

interface RetrievalPathOwnership {
  readonly schema_version: typeof OWNERSHIP_SCHEMA;
  readonly instance_id: string;
  readonly agent_id: string;
  readonly paths: readonly string[];
}

interface OpenClawConsumptionSnapshot extends Record<string, unknown> {
  readonly instance_id: string;
  readonly agent_id: string;
  readonly extra_paths: readonly string[];
  readonly managed_paths: readonly string[];
  readonly cutover_state?: HostSnapshot;
}

export interface OpenClawInstanceCutoverPort {
  capture(target: CutoverTarget): Promise<HostSnapshot>;
  applyTarget(target: CutoverTarget): Promise<void>;
  verifyTarget(target: CutoverTarget): Promise<void>;
  restore(snapshot: HostSnapshot): Promise<void>;
  verifyPrior(snapshot: HostSnapshot): Promise<void>;
}

interface ProjectionSentinel {
  readonly stableId: string;
  readonly checksum: string;
  readonly sourceRefs: readonly string[];
  readonly absolutePath: string;
  readonly document: string;
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringArray = (value: unknown, reason: string): readonly string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(reason);
  }
  return value as readonly string[];
};

const checksum = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const jsonFile = (value: unknown): string => `${JSON.stringify(value)}\n`;

const requireString = (value: unknown, reason: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(reason);
  return value;
};

const requireNumber = (value: unknown, reason: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(reason);
  return value;
};

const missingFile = (error: unknown): boolean =>
  isRecord(error) && error.code === "ENOENT";

const execFileAsync = promisify(execFile);

const runOpenClawCommand: OpenClawCommandRunner = async (arguments_) => {
  const configuredBinary = process.env.OPENCLAW_BIN;
  const command = configuredBinary ?? process.execPath;
  const commandArguments = configuredBinary === undefined
    ? [requireString(process.argv[1], "OPENCLAW_CLI_PATH_REQUIRED"), ...arguments_]
    : [...arguments_];
  const { stdout } = await execFileAsync(command, commandArguments, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
};

const parseCommandJson = (value: string, reason: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(reason, { cause: error });
  }
};

const parseToolOutput = (value: unknown): unknown => {
  const candidate = isRecord(value) && isRecord(value.result) ? value.result : value;
  if (!isRecord(candidate) || candidate.ok !== true || candidate.toolName !== "memory_get") {
    throw new Error("OPENCLAW_MEMORY_GET_FAILED");
  }
  if (!isRecord(candidate.output) || !Array.isArray(candidate.output.content)) {
    throw new Error("OPENCLAW_MEMORY_GET_INVALID");
  }
  const text = candidate.output.content.find((item) =>
    isRecord(item) && item.type === "text" && typeof item.text === "string");
  if (!isRecord(text)) throw new Error("OPENCLAW_MEMORY_GET_INVALID");
  return parseCommandJson(
    requireString(text.text, "OPENCLAW_MEMORY_GET_INVALID"),
    "OPENCLAW_MEMORY_GET_INVALID",
  );
};

export class OpenClawCliRetrievalCommands implements OpenClawRetrievalCommands {
  readonly #run: OpenClawCommandRunner;

  constructor(run: OpenClawCommandRunner = runOpenClawCommand) {
    this.#run = run;
  }

  async index(agentId: string): Promise<void> {
    await this.#run(["memory", "index", "--force", "--agent", agentId]);
  }

  async status(agentId: string): Promise<unknown> {
    return parseCommandJson(
      await this.#run(["memory", "status", "--deep", "--json", "--agent", agentId]),
      "OPENCLAW_MEMORY_STATUS_INVALID",
    );
  }

  async search(agentId: string, query: string): Promise<unknown> {
    return parseCommandJson(
      await this.#run([
        "memory",
        "search",
        "--json",
        "--agent",
        agentId,
        "--query",
        query,
        "--max-results",
        "10",
      ]),
      "OPENCLAW_MEMORY_SEARCH_INVALID",
    );
  }

  async get(agentId: string, path: string): Promise<unknown> {
    return parseToolOutput(parseCommandJson(
      await this.#run([
        "gateway",
        "call",
        "tools.invoke",
        "--json",
        "--timeout",
        "5000",
        "--params",
        JSON.stringify({
          name: "memory_get",
          args: { path, from: 1, lines: 10_000 },
          agentId,
        }),
      ]),
      "OPENCLAW_MEMORY_GET_INVALID",
    ));
  }
}

const findAgent = (config: Readonly<Record<string, unknown>>, agentId: string): JsonRecord => {
  const agents = config.agents;
  if (!isRecord(agents) || !Array.isArray(agents.list)) {
    throw new Error("OPENCLAW_AGENT_CONFIG_REQUIRED");
  }
  const agent = agents.list.find((candidate) =>
    isRecord(candidate) && candidate.id === agentId);
  if (!isRecord(agent)) throw new Error("OPENCLAW_AGENT_CONFIG_REQUIRED");
  return agent;
};

const readExtraPaths = (config: Readonly<Record<string, unknown>>, agentId: string): readonly string[] => {
  const agent = findAgent(config, agentId);
  if (agent.memorySearch === undefined) return [];
  if (!isRecord(agent.memorySearch)) throw new Error("OPENCLAW_MEMORY_CONFIG_INVALID");
  if (agent.memorySearch.extraPaths === undefined) return [];
  return stringArray(agent.memorySearch.extraPaths, "OPENCLAW_MEMORY_PATHS_INVALID");
};

const writeExtraPaths = (
  config: JsonRecord,
  agentId: string,
  paths: readonly string[],
): void => {
  const agent = findAgent(config, agentId);
  const memorySearch = agent.memorySearch === undefined ? {} : agent.memorySearch;
  if (!isRecord(memorySearch)) throw new Error("OPENCLAW_MEMORY_CONFIG_INVALID");
  memorySearch.extraPaths = [...paths];
  agent.memorySearch = memorySearch;
};

const includesDocumentIdentity = (
  value: string,
  target: SyncTarget,
  sentinel: ProjectionSentinel,
): boolean => [
  `generation_id: ${target.syncGeneration}`,
  `stable_id: ${sentinel.stableId}`,
  `checksum: ${sentinel.checksum}`,
  "source_refs:",
  ...sentinel.sourceRefs.map((reference) => `  - ${reference}`),
].every((marker) => value.includes(marker));

const loadProjectionSentinel = async (target: SyncTarget): Promise<ProjectionSentinel> => {
  let artifact: unknown;
  let manifest: unknown;
  try {
    [artifact, manifest] = await Promise.all([
      readFile(join(target.generationDirectory, "projection-entries.json"), "utf8")
        .then((value) => JSON.parse(value) as unknown),
      readFile(join(target.generationDirectory, "manifest.json"), "utf8")
        .then((value) => JSON.parse(value) as unknown),
    ]);
  } catch (error: unknown) {
    throw new Error("OPENCLAW_PROJECTION_SENTINEL_INVALID", { cause: error });
  }
  if (
    !isRecord(artifact) ||
    artifact.sync_generation !== target.syncGeneration ||
    artifact.source_revision !== target.sourceRevision ||
    !isRecord(artifact.payload) ||
    !Array.isArray(artifact.payload.entries) ||
    artifact.payload.entries.length === 0 ||
    !isRecord(manifest) ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error("OPENCLAW_PROJECTION_SENTINEL_INVALID");
  }
  const entries = [...artifact.payload.entries]
    .filter(isRecord)
    .sort((left, right) => String(left.stable_id).localeCompare(String(right.stable_id)));
  const entry = entries[0];
  if (entry === undefined) throw new Error("OPENCLAW_PROJECTION_SENTINEL_INVALID");
  const stableId = requireString(entry.stable_id, "OPENCLAW_PROJECTION_SENTINEL_INVALID");
  const entryChecksum = requireString(entry.checksum, "OPENCLAW_PROJECTION_SENTINEL_INVALID");
  const sourceRefs = stringArray(entry.source_refs, "OPENCLAW_PROJECTION_SENTINEL_INVALID");
  const prefix = `projections/${target.syncGeneration}/`;
  const documentPath = manifest.files
    .filter(isRecord)
    .map((file) => file.path)
    .find((path): path is string =>
      typeof path === "string" &&
      path.startsWith(prefix) &&
      path.includes(`/${stableId}/`) &&
      path.endsWith(".md"));
  if (documentPath === undefined) throw new Error("OPENCLAW_PROJECTION_SENTINEL_INVALID");
  const document = await readFile(join(target.generationDirectory, documentPath), "utf8");
  const sentinel = {
    stableId,
    checksum: entryChecksum,
    sourceRefs,
    absolutePath: resolve(target.generationDirectory, documentPath),
    document,
  };
  if (!includesDocumentIdentity(document, target, sentinel)) {
    throw new Error("OPENCLAW_PROJECTION_SENTINEL_INVALID");
  }
  return sentinel;
};

const assertDeepStatus = (
  value: unknown,
  target: SyncTarget,
  expectedFiles: number,
): string => {
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) {
    throw new Error("OPENCLAW_DEEP_STATUS_INVALID");
  }
  const result = value[0];
  if (
    result.agentId !== target.config.host.agent_id ||
    !isRecord(result.status) ||
    typeof result.status.workspaceDir !== "string" ||
    result.status.backend !== "builtin" ||
    result.status.dirty !== false ||
    !Array.isArray(result.status.extraPaths) ||
    !result.status.extraPaths.some((path) =>
      typeof path === "string" && resolve(path) === resolve(target.projectionDirectory)) ||
    typeof result.status.files !== "number" ||
    result.status.files < expectedFiles ||
    typeof result.status.chunks !== "number" ||
    result.status.chunks < expectedFiles ||
    !isRecord(result.status.vector) ||
    result.status.vector.enabled !== true ||
    result.status.vector.storeAvailable !== true ||
    result.status.vector.semanticAvailable !== true ||
    result.status.vector.available !== true ||
    result.status.vector.loadError !== undefined ||
    !isRecord(result.embeddingProbe) ||
    result.embeddingProbe.ok !== true ||
    result.indexError !== undefined ||
    !isRecord(result.scan) ||
    typeof result.scan.totalFiles !== "number" ||
    result.scan.totalFiles < expectedFiles ||
    !Array.isArray(result.scan.issues) ||
    result.scan.issues.length > 0
  ) {
    throw new Error("OPENCLAW_DEEP_STATUS_FAILED");
  }
  return result.status.workspaceDir;
};

const searchSentinel = (
  value: unknown,
  target: SyncTarget,
  sentinel: ProjectionSentinel,
  workspaceDirectory: string,
): { readonly path: string; readonly checksum: string } => {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw new Error("OPENCLAW_SEARCH_SENTINEL_INVALID");
  }
  const result = value.results.find((candidate) =>
    isRecord(candidate) &&
    typeof candidate.path === "string" &&
    resolve(workspaceDirectory, candidate.path) === sentinel.absolutePath);
  if (!isRecord(result)) throw new Error("OPENCLAW_SEARCH_SENTINEL_MISSING");
  const path = requireString(result.path, "OPENCLAW_SEARCH_SENTINEL_INVALID");
  const snippet = requireString(result.snippet, "OPENCLAW_SEARCH_SENTINEL_INVALID");
  if (!includesDocumentIdentity(snippet, target, sentinel)) {
    throw new Error("OPENCLAW_SEARCH_SENTINEL_IDENTITY_MISMATCH");
  }
  const startLine = requireNumber(result.startLine, "OPENCLAW_SEARCH_SENTINEL_INVALID");
  const endLine = requireNumber(result.endLine, "OPENCLAW_SEARCH_SENTINEL_INVALID");
  return {
    path,
    checksum: checksum(JSON.stringify({
      path,
      start_line: startLine,
      end_line: endLine,
      snippet,
    })),
  };
};

const getSentinelChecksum = (
  value: unknown,
  expectedPath: string,
  target: SyncTarget,
  sentinel: ProjectionSentinel,
): string => {
  if (!isRecord(value)) throw new Error("OPENCLAW_GET_SENTINEL_INVALID");
  const path = requireString(value.path, "OPENCLAW_GET_SENTINEL_INVALID");
  const text = requireString(value.text, "OPENCLAW_GET_SENTINEL_INVALID");
  const documentExcerpt = text.split("\n\n[More content available.", 1)[0] ?? "";
  if (
    path !== expectedPath ||
    value.from !== 1 ||
    !sentinel.document.startsWith(documentExcerpt) ||
    !includesDocumentIdentity(documentExcerpt, target, sentinel)
  ) {
    throw new Error("OPENCLAW_GET_SENTINEL_IDENTITY_MISMATCH");
  }
  const from = requireNumber(value.from, "OPENCLAW_GET_SENTINEL_INVALID");
  const lines = requireNumber(value.lines, "OPENCLAW_GET_SENTINEL_INVALID");
  return checksum(JSON.stringify({ path, text, from, lines }));
};

const getAfterHostReload = async (
  commands: OpenClawRetrievalCommands,
  agentId: string,
  path: string,
): Promise<unknown> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await commands.get(agentId, path);
    } catch (error: unknown) {
      lastError = error;
      if (attempt < 2) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
    }
  }
  throw lastError;
};

const searchResults = (value: unknown): readonly JsonRecord[] => {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw new Error("OPENCLAW_DOMAIN_SEARCH_INVALID");
  }
  return value.results.filter(isRecord);
};

const domainDocumentMarkers = (input: {
  readonly domainId: string;
  readonly projectionRevision: string;
  readonly stableId: string;
  readonly checksum: string;
}): readonly string[] => [
  `domain_id: ${input.domainId}`,
  `projection_revision: ${input.projectionRevision}`,
  `stable_id: ${input.stableId}`,
  `checksum: ${input.checksum}`,
];

const parseSnapshot = (
  value: HostSnapshot,
  config: InstanceRuntimeConfig,
): OpenClawConsumptionSnapshot => {
  if (
    value.instance_id !== config.instance_id ||
    value.agent_id !== config.host.agent_id
  ) {
    throw new Error("OPENCLAW_RETRIEVAL_SNAPSHOT_MISMATCH");
  }
  const cutoverState = value.cutover_state;
  if (cutoverState !== undefined && !isRecord(cutoverState)) {
    throw new Error("OPENCLAW_RETRIEVAL_SNAPSHOT_INVALID");
  }
  return {
    instance_id: config.instance_id,
    agent_id: config.host.agent_id,
    extra_paths: stringArray(
      value.extra_paths,
      "OPENCLAW_RETRIEVAL_SNAPSHOT_INVALID",
    ),
    managed_paths: stringArray(
      value.managed_paths,
      "OPENCLAW_RETRIEVAL_SNAPSHOT_INVALID",
    ),
    ...(cutoverState === undefined ? {} : { cutover_state: cutoverState }),
  };
};

export class OpenClawGenerationConsumptionAdapter implements HostTransitionPort {
  readonly #config: InstanceRuntimeConfig;
  readonly #api: OpenClawConsumptionApi;
  readonly #commands: OpenClawRetrievalCommands;
  readonly #cutover: OpenClawInstanceCutoverPort | undefined;

  constructor(
    config: InstanceRuntimeConfig,
    api: OpenClawConsumptionApi,
    commands: OpenClawRetrievalCommands,
    cutover?: OpenClawInstanceCutoverPort,
  ) {
    this.#config = config;
    this.#api = api;
    this.#commands = commands;
    this.#cutover = cutover;
  }

  async #loadOwnership(): Promise<RetrievalPathOwnership> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(
        resolve(this.#config.runtime_storage),
        RETRIEVAL_PATH_OWNERSHIP_FILE,
      ), "utf8")) as unknown;
    } catch (error: unknown) {
      if (missingFile(error)) {
        return {
          schema_version: OWNERSHIP_SCHEMA,
          instance_id: this.#config.instance_id,
          agent_id: this.#config.host.agent_id,
          paths: [],
        };
      }
      throw new Error("OPENCLAW_RETRIEVAL_OWNERSHIP_INVALID", { cause: error });
    }
    if (
      !isRecord(value) ||
      value.schema_version !== OWNERSHIP_SCHEMA ||
      value.instance_id !== this.#config.instance_id ||
      value.agent_id !== this.#config.host.agent_id
    ) {
      throw new Error("OPENCLAW_RETRIEVAL_OWNERSHIP_INVALID");
    }
    return {
      schema_version: OWNERSHIP_SCHEMA,
      instance_id: this.#config.instance_id,
      agent_id: this.#config.host.agent_id,
      paths: stringArray(value.paths, "OPENCLAW_RETRIEVAL_OWNERSHIP_INVALID"),
    };
  }

  async #writeOwnership(paths: readonly string[]): Promise<void> {
    await atomicWriteFile(join(
      resolve(this.#config.runtime_storage),
      RETRIEVAL_PATH_OWNERSHIP_FILE,
    ), jsonFile({
      schema_version: OWNERSHIP_SCHEMA,
      instance_id: this.#config.instance_id,
      agent_id: this.#config.host.agent_id,
      paths: [...paths],
    } satisfies RetrievalPathOwnership));
  }

  async capture(target?: SyncTarget): Promise<HostSnapshot> {
    const ownership = await this.#loadOwnership();
    const cutoverState = target?.cutover === undefined
      ? undefined
      : await this.#cutover?.capture(target.cutover);
    if (target?.cutover !== undefined && this.#cutover === undefined &&
      (target.cutover.plan.disable_mechanisms.length > 0 ||
        target.cutover.bootstrapProjections.length > 0)) {
      throw new Error("OPENCLAW_CUTOVER_PORT_REQUIRED");
    }
    if (target?.cutover !== undefined && this.#cutover !== undefined &&
      !isRecord(cutoverState)) {
      throw new Error("OPENCLAW_CUTOVER_SNAPSHOT_INVALID");
    }
    return {
      instance_id: this.#config.instance_id,
      agent_id: this.#config.host.agent_id,
      extra_paths: [...readExtraPaths(
        this.#api.config.current(),
        this.#config.host.agent_id,
      )],
      managed_paths: [...ownership.paths],
      ...(cutoverState === undefined ? {} : { cutover_state: cutoverState }),
    } satisfies OpenClawConsumptionSnapshot;
  }

  async applyTarget(target: SyncTarget): Promise<void> {
    if (
      target.config.instance_id !== this.#config.instance_id ||
      target.config.host.agent_id !== this.#config.host.agent_id
    ) {
      throw new Error("OPENCLAW_RETRIEVAL_TARGET_MISMATCH");
    }
    const ownership = await this.#loadOwnership();
    const priorManaged = new Set(ownership.paths.map((path) => resolve(path)));
    const projectionDirectory = resolve(target.projectionDirectory);
    const removePaths = new Set(
      (target.cutover?.plan.remove_retrieval_paths ?? []).map((path) => resolve(path)),
    );
    const preservePaths = new Set(
      (target.cutover?.plan.preserve_independent_paths ?? []).map((path) => resolve(path)),
    );
    // Persist ownership first so restart recovery can identify a target path even
    // when the Host commits its config write immediately before interruption.
    await this.#writeOwnership([projectionDirectory]);
    await this.#api.config.mutateConfigFile({
      afterWrite: { mode: "auto" },
      mutate: (draft) => {
        const existing = readExtraPaths(draft, this.#config.host.agent_id);
        const existingResolved = new Set(existing.map((path) => resolve(path)));
        for (const path of preservePaths) {
          if (!existingResolved.has(path)) {
            throw new Error(`OPENCLAW_PRESERVED_PATH_MISSING:${path}`);
          }
        }
        const preserved = existing.filter((path) =>
          !priorManaged.has(resolve(path)) && !removePaths.has(resolve(path)));
        writeExtraPaths(draft, this.#config.host.agent_id, [
          ...preserved,
          projectionDirectory,
        ]);
      },
    });
    if (target.cutover !== undefined) {
      await this.#cutover?.applyTarget(target.cutover);
    }
    await this.#commands.index(this.#config.host.agent_id);
  }

  async verifyTarget(target: SyncTarget): Promise<HostIndexEvidence> {
    if (target.cutover !== undefined) {
      const configuredPaths = new Set(readExtraPaths(
        this.#api.config.current(),
        this.#config.host.agent_id,
      ).map((path) => resolve(path)));
      if (target.cutover.plan.remove_retrieval_paths.some((path) =>
        configuredPaths.has(resolve(path)))) {
        throw new Error("OPENCLAW_LEGACY_RETRIEVAL_PATH_PRESENT");
      }
      if (target.cutover.plan.preserve_independent_paths.some((path) =>
        !configuredPaths.has(resolve(path)))) {
        throw new Error("OPENCLAW_INDEPENDENT_RETRIEVAL_PATH_MISSING");
      }
      await this.#cutover?.verifyTarget(target.cutover);
    }
    const sentinel = await loadProjectionSentinel(target);
    const artifact = JSON.parse(await readFile(
      join(target.generationDirectory, "projection-entries.json"),
      "utf8",
    )) as unknown;
    if (!isRecord(artifact) || !isRecord(artifact.payload) ||
      !Array.isArray(artifact.payload.entries)) {
      throw new Error("OPENCLAW_PROJECTION_SENTINEL_INVALID");
    }
    const workspaceDirectory = assertDeepStatus(
      await this.#commands.status(this.#config.host.agent_id),
      target,
      artifact.payload.entries.length
        + (target.domainIndexes ?? []).reduce((count, domain) =>
          count + domain.desired_count, 0),
    );
    const search = searchSentinel(
      await this.#commands.search(
        this.#config.host.agent_id,
        `${target.syncGeneration} ${sentinel.stableId} ${sentinel.checksum}`,
      ),
      target,
      sentinel,
      workspaceDirectory,
    );
    const getChecksum = getSentinelChecksum(
      await getAfterHostReload(
        this.#commands,
        this.#config.host.agent_id,
        search.path,
      ),
      search.path,
      target,
      sentinel,
    );
    const domains: HostDomainIndexEvidence[] = [];
    for (const domain of target.domainIndexes ?? []) {
      let indexedCount = 0;
      for (const document of domain.documents) {
        const result = await this.#commands.search(
          this.#config.host.agent_id,
          `${domain.projection_revision} ${document.stable_id} ${document.checksum}`,
        );
        const expectedPath = resolve(target.generationDirectory, document.document_path);
        const match = searchResults(result).find((candidate) => {
          const candidatePath = candidate.path;
          const snippet = candidate.snippet;
          return typeof candidatePath === "string"
          && resolve(workspaceDirectory, candidatePath) === expectedPath
          && typeof snippet === "string"
          && domainDocumentMarkers({
            domainId: domain.domain_id,
            projectionRevision: domain.projection_revision,
            stableId: document.stable_id,
            checksum: document.checksum,
          }).every((marker) => snippet.includes(marker));
        });
        if (match === undefined || typeof match.path !== "string") {
          throw new Error(`OPENCLAW_DOMAIN_DOCUMENT_MISSING:${document.stable_id}`);
        }
        const retrieved = await getAfterHostReload(
          this.#commands,
          this.#config.host.agent_id,
          match.path,
        );
        const retrievedText = isRecord(retrieved) ? retrieved.text : undefined;
        if (!isRecord(retrieved)
          || retrieved.path !== match.path
          || typeof retrievedText !== "string"
          || !domainDocumentMarkers({
            domainId: domain.domain_id,
            projectionRevision: domain.projection_revision,
            stableId: document.stable_id,
            checksum: document.checksum,
          }).every((marker) => retrievedText.includes(marker))
          || !retrievedText.includes(document.text_sentinel)) {
          throw new Error(`OPENCLAW_DOMAIN_DOCUMENT_GET_MISMATCH:${document.stable_id}`);
        }
        indexedCount += 1;
      }
      const previous = (target.previousDomainIndexes ?? []).find((candidate) =>
        candidate.domain_id === domain.domain_id);
      const replacementPrevious = previous?.projection_revision === domain.projection_revision
        ? undefined
        : previous;
      let previousStableIdHits = 0;
      let previousTextSentinelHits = 0;
      let previousSourceReferenceHits = 0;
      if (replacementPrevious !== undefined) {
        for (const document of replacementPrevious.documents) {
          previousStableIdHits += searchResults(
            await this.#commands.search(
              this.#config.host.agent_id,
              `${replacementPrevious.projection_revision} ${document.stable_id}`,
            ),
          ).length;
          previousTextSentinelHits += searchResults(
            await this.#commands.search(
              this.#config.host.agent_id,
              `${replacementPrevious.projection_revision} ${document.text_sentinel}`,
            ),
          ).length;
          for (const reference of document.source_references) {
            for (const marker of [reference.id, reference.path]) {
              previousSourceReferenceHits += searchResults(
                await this.#commands.search(
                  this.#config.host.agent_id,
                  `${replacementPrevious.projection_revision} ${marker}`,
                ),
              ).length;
            }
          }
        }
      }
      if (previousStableIdHits !== 0
        || previousTextSentinelHits !== 0
        || previousSourceReferenceHits !== 0) {
        throw new Error(`OPENCLAW_PRIOR_DOMAIN_HITS_PRESENT:${domain.domain_id}`);
      }
      domains.push({
        domainId: domain.domain_id,
        projectionRevision: domain.projection_revision,
        manifestChecksum: domain.manifest_checksum,
        desiredCount: domain.desired_count,
        indexedCount,
        previousRevision: previous?.projection_revision
          ?? target.expectedDomainEvidence?.find(({ domainId }) =>
            domainId === domain.domain_id)?.previousRevision
          ?? null,
        previousStableIdHits: 0,
        previousTextSentinelHits: 0,
        previousSourceReferenceHits: 0,
      });
    }
    return {
      deepStatus: "pass",
      generationId: target.syncGeneration,
      sourceRevision: target.sourceRevision,
      projectionChecksum: target.projectionChecksum,
      hostConfigChecksum: target.hostConfigChecksum,
      searchSentinelChecksum: search.checksum,
      getSentinelChecksum: getChecksum,
      ...(domains.length === 0 ? {} : { domains }),
    };
  }

  async restore(snapshotValue: HostSnapshot): Promise<void> {
    const snapshot = parseSnapshot(snapshotValue, this.#config);
    const currentOwnership = await this.#loadOwnership();
    const currentManaged = new Set(
      currentOwnership.paths.map((path) => resolve(path)),
    );
    await this.#api.config.mutateConfigFile({
      afterWrite: { mode: "auto" },
      mutate: (draft) => {
        const currentUnrelated = readExtraPaths(draft, this.#config.host.agent_id)
          .filter((path) => !currentManaged.has(resolve(path)));
        const restored = [...snapshot.extra_paths];
        const restoredResolved = new Set(restored.map((path) => resolve(path)));
        for (const path of currentUnrelated) {
          if (!restoredResolved.has(resolve(path))) restored.push(path);
        }
        writeExtraPaths(draft, this.#config.host.agent_id, restored);
      },
    });
    await this.#writeOwnership(snapshot.managed_paths);
    if (snapshot.cutover_state !== undefined) {
      if (this.#cutover === undefined) {
        throw new Error("OPENCLAW_CUTOVER_PORT_REQUIRED");
      }
      await this.#cutover?.restore(snapshot.cutover_state);
    }
    await this.#commands.index(this.#config.host.agent_id);
  }

  async verifyPrior(
    snapshot: HostSnapshot,
    target: SyncTarget,
  ): Promise<HostIndexEvidence> {
    const parsed = parseSnapshot(snapshot, this.#config);
    if (parsed.cutover_state !== undefined) {
      if (this.#cutover === undefined) {
        throw new Error("OPENCLAW_CUTOVER_PORT_REQUIRED");
      }
      await this.#cutover?.verifyPrior(parsed.cutover_state);
    }
    return this.verifyTarget(target);
  }
}
