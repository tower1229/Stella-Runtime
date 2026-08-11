import assert from "node:assert/strict";
import test from "node:test";

import plugin from "../../dist/openclaw/index.js";

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
}

test("OpenClaw discovers cognitive self-check through the plugin entry", async () => {
  const program = new FakeCommand();
  let descriptors;
  const api = {
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
    '{"status":"ok","pluginId":"cognitive-runtime"}',
  ]);
});
