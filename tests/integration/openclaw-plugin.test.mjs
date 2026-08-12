import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import plugin from "../../dist/openclaw/index.js";
import {
  provenanceDatabasePath,
  SqliteProvenanceStore,
} from "../../dist/provenance/index.js";
import { SqliteReanswerStore } from "../../dist/state/index.js";
import { writeSyntheticAuthority } from "../helpers/synthetic-authority.mjs";

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
  const api = {
    runtime: {
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

test("OpenClaw generation commands build, verify, activate, and deterministically rebuild", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stella-openclaw-generation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorityDirectory = join(root, "authority");
  const stateDirectory = join(root, "state");
  await writeSyntheticAuthority(authorityDirectory);
  const program = new FakeCommand();
  const api = {
    version: "0.1.0-beta.0",
    runtime: { llm: { complete: async () => ({}) } },
    registerCli(registrar) {
      return registrar({ program });
    },
  };
  await plugin.register(api);
  const generation = program.children.get("cognitive")?.children.get("generation");
  const output = [];
  const originalLog = console.log;
  console.log = (value) => output.push(JSON.parse(value));
  try {
    await generation.children.get("build").handler({
      authority: authorityDirectory,
      state: stateDirectory,
      revision: "revision-synthetic-1",
      json: true,
    });
    await generation.children.get("verify").handler({
      generation: output[0].staging_directory,
      json: true,
    });
    await generation.children.get("activate").handler({
      generation: output[0].staging_directory,
      state: stateDirectory,
      json: true,
    });
    await generation.children.get("rebuild").handler({
      authority: authorityDirectory,
      state: stateDirectory,
      revision: "revision-synthetic-1",
      json: true,
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(output[0].operation, "generation-build");
  assert.equal(output[1].valid, true);
  assert.equal(output[2].sync_generation, output[0].sync_generation);
  assert.equal(output[3].sync_generation, output[0].sync_generation);
  assert.equal(output[3].source_revision, "revision-synthetic-1");
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
    await cognitive.children.get("state").handler({
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

  assert.equal(output[0].operation, "state");
  assert.equal(output[0].view.revision, 1);
  assert.equal(output[0].view.states[0].payload.value, "synthetic");
  assert.equal(output[1].operation, "trace_get");
  assert.equal(output[1].trace.trace_id, "trace-synthetic-1");
  assert.equal(output[2].operation, "trace_query");
  assert.deepEqual(output[2].traces.map((trace) => trace.trace_id), [
    "trace-synthetic-1",
  ]);
});
