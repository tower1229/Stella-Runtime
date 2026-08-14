import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type {
  CurrentStateEvent,
  CurrentStateHead,
  ReanswerOutbox,
  StateCorrectionPreview,
  StateCorrectionReceipt,
  StateImportManifest,
  StateView as ContractStateView,
} from "../contracts/index.js";
import { validateContract } from "../contracts/index.js";
import {
  calculateStateViewChecksum,
  canonicalize,
  checksumCanonical,
  compareCanonicalStrings,
  stateViewVersion,
} from "./canonical.js";
import {
  runtimeDatabasePath,
  SqliteStateStore,
  type StateView as StoreStateView,
} from "./index.js";

const STATE_VIEW_SCHEMA = "cognitive-runtime.state-view/v2" as const;
const STATE_IMPORT_SCHEMA = "cognitive-runtime.state-import-manifest/v2" as const;
const STATE_PREVIEW_SCHEMA = "cognitive-runtime.state-correction-preview/v2" as const;

const omitField = (
  value: Readonly<Record<string, unknown>>,
  field: string,
): Readonly<Record<string, unknown>> => Object.fromEntries(
  Object.entries(value).filter(([key]) => key !== field),
);

const freeze = <T>(value: T): Readonly<T> => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
};

const assertContract = (
  name: "current-state-event" | "current-state-head" | "state-import-manifest" | "state-view" | "state-correction-preview" | "state-correction-receipt",
  value: unknown,
): void => {
  if (!validateContract(name, value).valid) {
    throw new Error(`STATE_CONTRACT_INVALID:${name}`);
  }
};

const contractViewFromValues = (input: {
  readonly instanceId: string;
  readonly activeSeq: number;
  readonly values: ContractStateView["values"];
  readonly createdAt: string;
}): ContractStateView => {
  const values = [...input.values].sort((left, right) =>
    compareCanonicalStrings(left.state_id, right.state_id));
  const checksum = calculateStateViewChecksum(input.instanceId, input.activeSeq, values);
  const view: ContractStateView = {
    schema_version: STATE_VIEW_SCHEMA,
    instance_id: input.instanceId,
    view_version: stateViewVersion(input.activeSeq, checksum),
    active_seq: input.activeSeq,
    values,
    checksum,
    created_at: input.createdAt,
  };
  assertContract("state-view", view);
  return freeze(structuredClone(view));
};

const valuesFromStoreView = (view: StoreStateView): ContractStateView["values"] =>
  view.states.map((entry) => ({
    state_id: entry.stateId,
    value: Object.hasOwn(entry.payload, "value") ? entry.payload.value : entry.payload,
    source_event_id: entry.eventId,
  }));

const headFromView = (view: ContractStateView): CurrentStateHead => ({
  active_seq: view.active_seq,
  view_version: view.view_version,
  checksum: view.checksum,
  activated_at: view.created_at,
});

const reduceEvents = (
  instanceId: string,
  events: readonly CurrentStateEvent[],
  createdAt: string,
): ContractStateView => {
  const values = new Map<string, ContractStateView["values"][number]>();
  events.forEach((event) => values.set(event.state_id, {
    state_id: event.state_id,
    value: Object.hasOwn(event.payload, "value") ? event.payload.value : event.payload,
    source_event_id: event.event_id,
  }));
  return contractViewFromValues({
    instanceId,
    activeSeq: events.length,
    values: [...values.values()],
    createdAt,
  });
};

export interface StateImportSourcePolicy {
  readonly name: string;
  accepts(event: CurrentStateEvent, mapping: StateImportManifest["source_mappings"][number]): boolean;
}

export interface ExactStateImportAuthorization {
  readonly eventId: string;
  readonly eventChecksum: string;
  readonly sourceKind: "user_confirmed" | "independently_verified";
  readonly sourceRef: string;
  readonly verification: string;
  readonly verifiedAt: string;
}

export const calculateCurrentStateEventChecksum = (
  event: CurrentStateEvent,
): string => checksumCanonical(event);

export const createExactStateImportPolicy = (options: {
  readonly authorizations: readonly ExactStateImportAuthorization[];
  readonly now: () => string;
  readonly maxAuthorizationAgeMs: number;
}): StateImportSourcePolicy => {
  if (!Number.isFinite(options.maxAuthorizationAgeMs) || options.maxAuthorizationAgeMs < 0) {
    throw new Error("STATE_IMPORT_AUTHORIZATION_AGE_INVALID");
  }
  const authorizations = new Map(options.authorizations.map((item) => [item.eventId, item]));
  if (authorizations.size !== options.authorizations.length) {
    throw new Error("STATE_IMPORT_AUTHORIZATION_DUPLICATE");
  }
  return Object.freeze({
    name: "exact-state-import",
    accepts: (
      event: CurrentStateEvent,
      mapping: StateImportManifest["source_mappings"][number],
    ): boolean => {
      const authorization = authorizations.get(event.event_id);
      const age = authorization === undefined
        ? Number.NaN
        : Date.parse(options.now()) - Date.parse(authorization.verifiedAt);
      return authorization !== undefined &&
        Number.isFinite(age) && age >= 0 && age <= options.maxAuthorizationAgeMs &&
        authorization.eventChecksum === calculateCurrentStateEventChecksum(event) &&
        authorization.sourceKind === mapping.source_kind &&
        authorization.sourceRef === mapping.source_ref &&
        authorization.verification === mapping.verification;
    },
  });
};

export interface StateInitializationResult {
  readonly created: boolean;
  readonly head: CurrentStateHead;
  readonly view: ContractStateView;
}

export interface StateImportResult {
  readonly imported: boolean;
  readonly importId: string;
  readonly head: CurrentStateHead;
  readonly view: ContractStateView;
}

export interface StateCorrectionPlanInput {
  readonly previewId: string;
  readonly event: CurrentStateEvent;
  readonly expiresAt: string;
}

export interface StateCorrectionApplyInput {
  readonly preview: StateCorrectionPreview;
  readonly previewChecksum?: string;
  readonly receipt?: StateCorrectionReceipt;
  readonly correctionId: string;
  readonly sessionKeyHash: string;
  readonly priorRunId: string;
  readonly outboxIdempotencyKey: string;
}

export interface StateCorrectionResult {
  readonly previewId: string;
  readonly view: ContractStateView;
  readonly outbox: ReanswerOutbox;
}

export interface StateManagementPort {
  initialize(): Promise<StateInitializationResult>;
  import(manifest: StateImportManifest, options?: { readonly policy?: StateImportSourcePolicy }): Promise<StateImportResult>;
  view(options?: { readonly revision?: number }): Promise<ContractStateView>;
  planCorrection(input: StateCorrectionPlanInput): Promise<StateCorrectionPreview>;
  applyCorrection(input: StateCorrectionApplyInput): Promise<StateCorrectionResult>;
  markRunServed(runId: string): void;
  close(): void;
}

export interface StateManagementOptions {
  readonly stateRoot: string;
  readonly instanceId: string;
  readonly now?: () => string;
}

class SqliteStateManagementPort implements StateManagementPort {
  readonly #databasePath: string;
  readonly #instanceId: string;
  readonly #now: () => string;
  #store: SqliteStateStore | null = null;

  constructor(options: StateManagementOptions) {
    this.#databasePath = runtimeDatabasePath(options.stateRoot, options.instanceId);
    this.#instanceId = options.instanceId;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async initialize(): Promise<StateInitializationResult> {
    if (existsSync(this.#databasePath)) {
      const view = await this.view();
      return { created: false, head: headFromView(view), view };
    }
    mkdirSync(dirname(this.#databasePath), { recursive: true });
    const view = contractViewFromValues({
      instanceId: this.#instanceId,
      activeSeq: 0,
      values: [],
      createdAt: this.#now(),
    });
    this.#store = new SqliteStateStore({
      databasePath: this.#databasePath,
      instanceId: this.#instanceId,
      initialHead: headFromView(view),
      now: this.#now,
    });
    return { created: true, head: headFromView(view), view };
  }

  async import(
    manifest: StateImportManifest,
    options: { readonly policy?: StateImportSourcePolicy } = {},
  ): Promise<StateImportResult> {
    assertContract("state-import-manifest", manifest);
    if (manifest.instance_id !== this.#instanceId) throw new Error("STATE_INSTANCE_MISMATCH");
    if (calculateStateImportManifestChecksum(manifest) !== manifest.checksum) {
      throw new Error("STATE_IMPORT_MANIFEST_CHECKSUM_MISMATCH");
    }
    const expectedView = manifest.expected_view as unknown;
    const expectedHead = manifest.expected_head as unknown;
    assertContract("state-view", expectedView);
    assertContract("current-state-head", expectedHead);
    const targetView = expectedView as ContractStateView;
    const targetHead = expectedHead as CurrentStateHead;
    const events = manifest.events as unknown as CurrentStateEvent[];
    events.forEach((event, index) => {
      assertContract("current-state-event", event);
      if (event.seq !== index + 1) throw new Error("STATE_IMPORT_EVENT_SEQUENCE_INVALID");
    });
    const mappings = new Map(manifest.source_mappings.map((item) => [item.event_id, item]));
    if (mappings.size !== events.length || events.some((event) => !mappings.has(event.event_id))) {
      throw new Error("STATE_IMPORT_SOURCE_MAPPING_INVALID");
    }
    if (events.length > 0 && options.policy === undefined) {
      throw new Error("STATE_IMPORT_POLICY_REQUIRED");
    }
    for (const event of events) {
      const mapping = mappings.get(event.event_id);
      if (mapping === undefined || event.source_ref !== mapping.source_ref ||
        event.source_kind !== mapping.source_kind ||
        (options.policy !== undefined && !options.policy.accepts(event, mapping))) {
        throw new Error("STATE_IMPORT_SOURCE_REJECTED");
      }
    }
    const simulated = reduceEvents(this.#instanceId, events, manifest.created_at);
    if (JSON.stringify(canonicalize(simulated)) !== JSON.stringify(canonicalize(targetView)) ||
      JSON.stringify(canonicalize(headFromView(simulated))) !== JSON.stringify(canonicalize(targetHead))) {
      throw new Error("STATE_IMPORT_EXPECTED_HEAD_MISMATCH");
    }
    const store = this.#writeStore();
    const imported = store.importBaseline({
      importId: manifest.import_id,
      manifestChecksum: manifest.checksum,
      initializedHeadChecksum: manifest.initialized_head_checksum,
      events,
      expectedHead: targetHead,
    });
    return {
      imported,
      importId: manifest.import_id,
      head: targetHead,
      view: imported ? await this.view() : freeze(structuredClone(targetView)),
    };
  }

  async view(options: { readonly revision?: number } = {}): Promise<ContractStateView> {
    if (!existsSync(this.#databasePath)) throw new Error("STATE_STORE_MISSING");
    const temporary = this.#store === null;
    const store = this.#store ?? new SqliteStateStore({
      databasePath: this.#databasePath,
      instanceId: this.#instanceId,
      readOnly: true,
    });
    try {
      const internal = await store.view({
        instanceId: this.#instanceId,
        ...(options.revision === undefined ? {} : { revision: options.revision }),
      });
      return contractViewFromValues({
        instanceId: this.#instanceId,
        activeSeq: internal.revision,
        values: valuesFromStoreView(internal),
        createdAt: store.getViewActivatedAt(internal.revision),
      });
    } finally {
      if (temporary) store.close();
    }
  }

  async planCorrection(input: StateCorrectionPlanInput): Promise<StateCorrectionPreview> {
    const base = await this.view();
    assertContract("current-state-event", input.event);
    if (input.event.seq !== base.active_seq + 1) throw new Error("STATE_HEAD_CAS_FAILED");
    const body = {
      schema_version: STATE_PREVIEW_SCHEMA,
      preview_id: input.previewId,
      instance_id: this.#instanceId,
      base_state_view_checksum: base.checksum,
      proposed_event: input.event,
      created_at: this.#now(),
      expires_at: input.expiresAt,
    };
    const preview = {
      ...body,
      proposed_event: body.proposed_event as unknown as Record<string, unknown>,
      preview_checksum: checksumCanonical(body),
    } satisfies StateCorrectionPreview;
    assertContract("state-correction-preview", preview);
    return freeze(structuredClone(preview));
  }

  async applyCorrection(input: StateCorrectionApplyInput): Promise<StateCorrectionResult> {
    assertContract("state-correction-preview", input.preview);
    const calculated = checksumCanonical(omitField(
      input.preview as unknown as Readonly<Record<string, unknown>>,
      "preview_checksum",
    ));
    if (calculated !== input.preview.preview_checksum ||
      (input.previewChecksum !== undefined && input.previewChecksum !== input.preview.preview_checksum)) {
      throw new Error("STATE_CORRECTION_PREVIEW_CHECKSUM_MISMATCH");
    }
    if (input.preview.instance_id !== this.#instanceId) {
      throw new Error("STATE_CORRECTION_INSTANCE_MISMATCH");
    }
    if (input.receipt !== undefined) {
      assertContract("state-correction-receipt", input.receipt);
      if (input.receipt.preview_id !== input.preview.preview_id ||
        input.receipt.preview_checksum !== input.preview.preview_checksum ||
        input.receipt.base_state_view_checksum !== input.preview.base_state_view_checksum) {
        throw new Error("STATE_CORRECTION_RECEIPT_MISMATCH");
      }
      if (input.outboxIdempotencyKey !== input.receipt.receipt_id) {
        throw new Error("STATE_CORRECTION_RECEIPT_SINGLE_USE_REQUIRED");
      }
    } else if (input.previewChecksum === undefined) {
      throw new Error("STATE_CORRECTION_CONFIRMATION_REQUIRED");
    }
    const store = this.#writeStore();
    const existing = store.get(input.correctionId);
    if (existing !== null) {
      const repeated = await store.correct({
        event: input.preview.proposed_event as unknown as CurrentStateEvent,
        confirmation: {
          previewId: input.preview.preview_id,
          previewChecksum: input.preview.preview_checksum,
          ...(input.receipt === undefined ? {} : { receiptId: input.receipt.receipt_id }),
        },
        outbox: {
          correctionId: input.correctionId,
          instanceId: this.#instanceId,
          sessionKeyHash: input.sessionKeyHash,
          priorRunId: input.priorRunId,
          idempotencyKey: input.outboxIdempotencyKey,
          createdAt: this.#now(),
        },
      });
      return { previewId: input.preview.preview_id, view: await this.view(), outbox: repeated };
    }
    if (Date.parse(input.preview.expires_at) < Date.parse(this.#now())) {
      throw new Error("STATE_CORRECTION_PREVIEW_EXPIRED");
    }
    const current = await this.view();
    if (current.checksum !== input.preview.base_state_view_checksum) {
      throw new Error("STATE_CORRECTION_BASE_VIEW_MISMATCH");
    }
    const outbox = await store.correct({
      event: input.preview.proposed_event as unknown as CurrentStateEvent,
      confirmation: {
        previewId: input.preview.preview_id,
        previewChecksum: input.preview.preview_checksum,
        ...(input.receipt === undefined ? {} : { receiptId: input.receipt.receipt_id }),
      },
      outbox: {
        correctionId: input.correctionId,
        instanceId: this.#instanceId,
        sessionKeyHash: input.sessionKeyHash,
        priorRunId: input.priorRunId,
        idempotencyKey: input.outboxIdempotencyKey,
        createdAt: this.#now(),
      },
    });
    return { previewId: input.preview.preview_id, view: await this.view(), outbox };
  }

  markRunServed(runId: string): void {
    this.#writeStore().markRunServed(runId);
  }

  close(): void {
    this.#store?.close();
    this.#store = null;
  }

  #writeStore(): SqliteStateStore {
    if (!existsSync(this.#databasePath)) throw new Error("STATE_STORE_MISSING");
    this.#store ??= new SqliteStateStore({
      databasePath: this.#databasePath,
      instanceId: this.#instanceId,
      now: this.#now,
    });
    return this.#store;
  }
}

export const calculateStateImportManifestChecksum = (manifest: StateImportManifest): string =>
  checksumCanonical(omitField(
    manifest as unknown as Readonly<Record<string, unknown>>,
    "checksum",
  ));

export const prepareStateImportManifest = async (
  port: StateManagementPort,
  input: {
    readonly importId: string;
    readonly events: readonly CurrentStateEvent[];
    readonly sourceMappings: StateImportManifest["source_mappings"];
    readonly createdAt: string;
  },
): Promise<StateImportManifest> => {
  const initialized = await port.view();
  if (initialized.active_seq !== 0) throw new Error("STATE_IMPORT_REQUIRES_INITIALIZED_EMPTY_HEAD");
  const expectedView = input.events.length === 0
    ? initialized
    : reduceEvents(initialized.instance_id, input.events, input.createdAt);
  const body = {
    schema_version: STATE_IMPORT_SCHEMA,
    import_id: input.importId,
    instance_id: initialized.instance_id,
    initialized_head_checksum: initialized.checksum,
    events: structuredClone(input.events) as unknown as StateImportManifest["events"],
    source_mappings: structuredClone(input.sourceMappings),
    expected_head: headFromView(expectedView) as unknown as Record<string, unknown>,
    expected_view: expectedView as unknown as Record<string, unknown>,
    created_at: input.createdAt,
  };
  const manifest: StateImportManifest = { ...body, checksum: checksumCanonical(body) };
  assertContract("state-import-manifest", manifest);
  return freeze(structuredClone(manifest));
};

export const createStateManagementPort = (options: StateManagementOptions): StateManagementPort =>
  new SqliteStateManagementPort(options);
