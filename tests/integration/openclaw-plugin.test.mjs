import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import plugin from "../../dist/openclaw/index.js";
import {
  provenanceDatabasePath,
  SqliteProvenanceStore,
} from "../../dist/provenance/index.js";
import {
  SqliteReanswerStore,
} from "../../dist/state/index.js";
import {
  calculateCurrentStateEventChecksum,
  createStateManagementPort,
  prepareStateImportManifest,
} from "../../dist/state/management.js";
import {
  commitSyntheticAuthority,
  writeSyntheticAuthority,
} from "../helpers/synthetic-authority.mjs";

class FakeCommand {
  children = new Map();
  handler;

  command(name) {
    const child = new FakeCommand();
    this.children.set(name, child);
    return child;
  }

  description() {
    return this;
  }

  action(handler) {
    this.handler = handler;
    return this;
  }

  requiredOption() {
    return this;
  }

  option() {
    return this;
  }
}

test("OpenClaw discovers cognitive self-check through the plugin entry", async () => {
  const program = new FakeCommand();
  let descriptors;
  let interactiveRegistration;
  const api = {
    runtime: {
      version: "2026.6.34",
      llm: {
        complete: async () => {
          throw new Error("not invoked by self-check");
        },
      },
    },
    registerCli(registrar, options) {
      descriptors = options.descriptors;
      return registrar({ program });
    },
    registerInteractiveHandler(registration) {
      interactiveRegistration = registration;
    },
  };

  assert.equal(plugin.id, "cognitive-runtime");
  await plugin.register(api);
  assert.deepEqual(descriptors, [
    {
      name: "cognitive",
      description: "Inspect the cognitive runtime",
      hasSubcommands: true,
    },
  ]);
  assert.equal(interactiveRegistration?.channel, "telegram");
  assert.equal(interactiveRegistration?.namespace, "crad");
  assert.equal(typeof interactiveRegistration?.handler, "function");

  const selfCheck = program.children
    .get("cognitive")
    ?.children.get("self-check");
  assert.equal(typeof selfCheck?.handler, "function");

  const output = [];
  const originalLog = console.log;
  console.log = (value) => output.push(value);
  try {
    await selfCheck.handler();
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(output, [
    '{"status":"ok","pluginId":"cognitive-runtime","hostCapabilities":{"hostModelCompletion":"llm.complete"}}',
  ]);
});

test("OpenClaw exposes read-only validate, non-activating build, and generation show", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-openclaw-generation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorityDirectory = join(root, "authority");
  const stateDirectory = join(root, "state");
  await writeSyntheticAuthority(authorityDirectory);
  const sourceRevision = await commitSyntheticAuthority(authorityDirectory);
  const program = new FakeCommand();
  const api = {
    version: "0.1.0-beta.0",
    runtime: { llm: { complete: async () => ({}) } },
    registerCli(registrar) {
      return registrar({ program });
    },
  };
  await plugin.register(api);
  const cognitive = program.children.get("cognitive");
  const generation = cognitive.children.get("generation");
  const output = [];
  const originalLog = console.log;
  console.log = (value) => output.push(JSON.parse(value));
  try {
    await cognitive.children.get("validate").handler({
      authority: authorityDirectory,
      revision: sourceRevision,
      json: true,
    });
    await cognitive.children.get("build").handler({
      authority: authorityDirectory,
      state: stateDirectory,
      revision: sourceRevision,
      bootstrap: "USER.md",
      json: true,
    });
    await generation.children.get("show").handler({
      generation: output[1].sync_generation,
      state: stateDirectory,
      json: true,
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(output[0].operation, "validate");
  assert.equal(output[0].source_revision, sourceRevision);
  assert.equal(output[0].record_count, 3);
  assert.equal(output[1].operation, "build");
  assert.equal(output[1].source_revision, sourceRevision);
  assert.equal(output[1].reused, false);
  assert.deepEqual(output[1].bootstrap_projections.map((projection) => projection.target), [
    "USER.md",
  ]);
  assert.equal(output[2].operation, "generation_show");
  assert.equal(output[2].sync_generation, output[1].sync_generation);
  assert.equal(output[2].source_revision, sourceRevision);
  assert.equal(output[2].active, false);
  assert.equal(generation.children.has("activate"), false);
  assert.equal(generation.children.has("rebuild"), false);
});

test("OpenClaw registration does not use rejected host paths", async () => {
  const rejected = [
    "runContext",
    "enqueueNextTurnInjection",
    "runEmbeddedAgent",
    "scheduleSessionTurn",
  ];
  const rejectAccess = (target) => new Proxy(target, {
    get(value, property, receiver) {
      assert.equal(rejected.includes(String(property)), false);
      return Reflect.get(value, property, receiver);
    },
  });
  const api = rejectAccess({
    runtime: rejectAccess({
      llm: rejectAccess({ complete: async () => ({}) }),
      workflow: rejectAccess({}),
    }),
    registerCli() {},
  });

  await plugin.register(api);
});

test("OpenClaw plugin rejects Telegram registration on an unsmoked Host", () => {
  assert.throws(
    () => plugin.register({
      runtime: {
        version: "2026.6.35",
        llm: { complete: async () => ({}) },
      },
      registerInteractiveHandler() {},
      registerCli() {},
    }),
    /TELEGRAM_CONFIRMATION_HOST_UNSUPPORTED/,
  );
});

test("OpenClaw recovery commands expose backup, read-only verify, and restore JSON", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-openclaw-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, "state");
  const sourceDirectory = join(stateRoot, "instance-synthetic");
  await mkdir(sourceDirectory, { recursive: true });
  const store = new SqliteReanswerStore({
    databasePath: join(sourceDirectory, "runtime.sqlite"),
    initialHead: {
      active_seq: 0,
      view_version: "view-synthetic-0",
      checksum: `sha256:${"0".repeat(64)}`,
      activated_at: "2026-08-11T00:00:00.000Z",
    },
  });
  store.close();
  const program = new FakeCommand();
  const api = {
    version: "0.0.0",
    pluginConfig: {
      recovery: {
        stateRoot,
        activeInstanceId: "instance-synthetic",
        instances: {
          "instance-synthetic": {
            authorityRevision: "revision-synthetic-1",
          },
        },
      },
    },
    runtime: { llm: { complete: async () => ({}) } },
    on(event, handler) {
      this.hooks ??= new Map();
      this.hooks.set(event, handler);
    },
    registerCli(registrar) {
      return registrar({ program });
    },
  };
  await plugin.register(api);
  const cognitive = program.children.get("cognitive");
  const output = [];
  const originalLog = console.log;
  console.log = (value) => output.push(JSON.parse(value));
  try {
    const snapshotDirectory = join(root, "snapshot");
    await cognitive.children.get("backup").handler({
      instance: "instance-synthetic",
      output: snapshotDirectory,
      json: true,
    });
    await cognitive.children.get("verify").handler({
      snapshot: snapshotDirectory,
      json: true,
    });
    await rm(sourceDirectory, { recursive: true, force: true });
    await cognitive.children.get("restore").handler({
      instance: "instance-synthetic",
      snapshot: snapshotDirectory,
      json: true,
    });
    await api.hooks.get("before_prompt_build")({}, {
      runId: "run-synthetic-after-restore",
    });
    await cognitive.children.get("restore").handler({
      instance: "instance-synthetic",
      snapshot: snapshotDirectory,
      json: true,
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(output[0].operation, "backup");
  assert.match(output[0].artifact_id, /^sha256:[a-f0-9]{64}$/);
  assert.equal(output[1].operation, "verify");
  assert.equal(output[1].integrity_result.status, "pass");
  assert.equal(output[2].operation, "restore");
  assert.equal(output[2].restored_active_head.active_seq, 0);
  assert.equal("live_database_path" in output[2], false);
  assert.equal(output[3].compatibility_result.status, "fail");
  assert.ok(
    output[3].compatibility_result.reason_codes.includes("TARGET_HAS_SERVED_RUN"),
  );
});

test("OpenClaw cognitive state and trace get/query return structured read-only results", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-openclaw-inspect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, "state");
  const instanceId = "instance-synthetic";
  const instanceDirectory = join(stateRoot, instanceId);
  await mkdir(instanceDirectory, { recursive: true });
  const state = new SqliteReanswerStore({
    databasePath: join(instanceDirectory, "runtime.sqlite"),
    instanceId,
    initialHead: {
      active_seq: 0,
      view_version: "view-synthetic-0",
      checksum: `sha256:${"0".repeat(64)}`,
      activated_at: "2026-08-11T00:00:00.000Z",
    },
  });
  await state.correct({
    event: {
      seq: 1,
      event_id: "event-synthetic-1",
      state_id: "state-synthetic",
      event_type: "correction",
      payload: { value: "synthetic" },
      observed_at: "2026-08-11T00:00:01.000Z",
      source_kind: "user_explicit",
      idempotency_key: "event-key-synthetic-1",
      created_at: "2026-08-11T00:00:01.000Z",
    },
    outbox: {
      correctionId: "correction-synthetic-1",
      instanceId,
      sessionKeyHash: `sha256:${"1".repeat(64)}`,
      priorRunId: "run-prior-synthetic",
      idempotencyKey: "outbox-key-synthetic-1",
      createdAt: "2026-08-11T00:00:01.000Z",
    },
  });
  state.close();
  const provenance = new SqliteProvenanceStore({
    databasePath: provenanceDatabasePath(stateRoot, instanceId),
  });
  await provenance.record({
    trace_id: "trace-synthetic-1",
    run_id: "run-synthetic-1",
    session_key_hash: `sha256:${"1".repeat(64)}`,
    sync_generation: "generation-synthetic-1",
    knowledge_snapshot: "revision-synthetic-1",
    state_view_version: "state-view-synthetic-1",
    validated_router_result: null,
    cognitive_bindings: [],
    stable_refs: [{ id: "state-synthetic", status: "injected" }],
    unresolved_conflicts: [],
    trace_status: "completed",
    eval_eligible: true,
    created_at: "2026-08-11T00:00:02.000Z",
  });
  provenance.close();

  const program = new FakeCommand();
  const api = {
    pluginConfig: {
      recovery: {
        stateRoot,
        activeInstanceId: instanceId,
        instances: {
          [instanceId]: { authorityRevision: "revision-synthetic-1" },
        },
      },
    },
    runtime: { llm: { complete: async () => ({}) } },
    on() {},
    registerCli(registrar) { return registrar({ program }); },
  };
  await plugin.register(api);
  const cognitive = program.children.get("cognitive");
  const output = [];
  const originalLog = console.log;
  console.log = (value) => output.push(JSON.parse(value));
  try {
    await cognitive.children.get("state").children.get("view").handler({
      instance: instanceId,
      revision: "1",
      json: true,
    });
    await cognitive.children.get("trace").children.get("get").handler({
      instance: instanceId,
      trace: "trace-synthetic-1",
      json: true,
    });
    await cognitive.children.get("trace").children.get("query").handler({
      instance: instanceId,
      status: "completed",
      ref: "state-synthetic",
      limit: "10",
      json: true,
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(output[0].operation, "state_view");
  assert.equal(output[0].view.active_seq, 1);
  assert.equal(output[0].view.values[0].value, "synthetic");
  assert.equal(output[1].operation, "trace_get");
  assert.equal(output[1].trace.trace_id, "trace-synthetic-1");
  assert.equal(output[2].operation, "trace_query");
  assert.deepEqual(output[2].traces.map((trace) => trace.trace_id), [
    "trace-synthetic-1",
  ]);
});

test("OpenClaw state initialize/import/view/correct expose the formal JSON workflow", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-openclaw-state-operations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, "state");
  const instanceId = "instance-operations";
  const program = new FakeCommand();
  await plugin.register({
    pluginConfig: {
      recovery: {
        stateRoot,
        activeInstanceId: instanceId,
        instances: { [instanceId]: { authorityRevision: "revision-synthetic-1" } },
      },
    },
    runtime: { llm: { complete: async () => ({}) } },
    registerCli(registrar) { return registrar({ program }); },
  });
  const state = program.children.get("cognitive").children.get("state");
  const output = [];
  const originalLog = console.log;
  console.log = (value) => output.push(JSON.parse(value));
  try {
    await state.children.get("initialize").handler({ instance: instanceId, json: true });
    const helper = createStateManagementPort({ stateRoot, instanceId });
    const baselineEvent = {
      seq: 1,
      event_id: "event-cli-baseline-1",
      state_id: "state-cli-location",
      event_type: "imported_baseline",
      payload: { value: "Shanghai", prior_history: "unknown" },
      observed_at: "2026-08-14T00:00:00.000Z",
      source_kind: "user_confirmed",
      source_ref: "confirmation-cli-1",
      idempotency_key: "event-cli-baseline-key-1",
      created_at: "2026-08-14T00:00:00.000Z",
    };
    const manifest = await prepareStateImportManifest(helper, {
      importId: "import-cli-1",
      events: [baselineEvent],
      sourceMappings: [{
        event_id: baselineEvent.event_id,
        source_kind: "user_confirmed",
        source_ref: baselineEvent.source_ref,
        verification: "Exact value confirmed at cutover",
      }],
      createdAt: "2026-08-14T00:00:00.000Z",
    });
    helper.close();
    const manifestPath = join(root, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    const authorizationPath = join(root, "authorization.json");
    await writeFile(authorizationPath, JSON.stringify({
      authorizations: [{
        eventId: baselineEvent.event_id,
        eventChecksum: calculateCurrentStateEventChecksum(baselineEvent),
        sourceKind: "user_confirmed",
        sourceRef: baselineEvent.source_ref,
        verification: "Exact value confirmed at cutover",
        verifiedAt: new Date().toISOString(),
      }],
      max_authorization_age_ms: 60_000,
    }), "utf8");
    await state.children.get("import").handler({
      instance: instanceId,
      manifest: manifestPath,
      authorization: authorizationPath,
      json: true,
    });
    await state.children.get("view").handler({ instance: instanceId, json: true });

    const correctionEventPath = join(root, "correction-event.json");
    await writeFile(correctionEventPath, JSON.stringify({
      ...baselineEvent,
      seq: 2,
      event_id: "event-cli-correction-2",
      event_type: "correction",
      payload: { value: "Hangzhou" },
      source_ref: undefined,
      idempotency_key: "event-cli-correction-key-2",
    }), "utf8");
    await state.children.get("correct").children.get("plan").handler({
      instance: instanceId,
      preview: "preview-cli-2",
      event: correctionEventPath,
      expires: "2099-08-15T00:00:00.000Z",
      json: true,
    });
    const previewPath = join(root, "preview.json");
    await writeFile(previewPath, JSON.stringify(output.at(-1).preview), "utf8");
    await state.children.get("correct").children.get("apply").handler({
      instance: instanceId,
      preview: previewPath,
      checksum: output.at(-1).preview.preview_checksum,
      correction: "correction-cli-2",
      session: `sha256:${"5".repeat(64)}`,
      priorRun: "run-cli-prior-2",
      idempotencyKey: "outbox-cli-key-2",
      json: true,
    });
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(output.map((entry) => entry.operation), [
    "state_initialize",
    "state_import",
    "state_view",
    "state_correct_plan",
    "state_correct_apply",
  ]);
  assert.equal(output[2].view.values[0].value, "Shanghai");
  assert.equal(output[4].view.values[0].value, "Hangzhou");
});
