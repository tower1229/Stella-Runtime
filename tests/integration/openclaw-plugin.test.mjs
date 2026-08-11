import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import plugin from "../../dist/openclaw/index.js";
import { SqliteReanswerStore } from "../../dist/state/index.js";

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
