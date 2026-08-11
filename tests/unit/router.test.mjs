import assert from "node:assert/strict";
import test from "node:test";

import { StrictRouter } from "../../dist/router/index.js";

const checksum = (digit) => `sha256:${digit.repeat(64)}`;
const result = {
  memory_route: "required",
  state_refs: ["state-synthetic"],
  governing: {
    system: "cog-governing",
    kernel_version: "3",
    modules: ["cog-module"],
  },
  frameworks: { primary: "cog-method", secondary: null },
  retrieval_plan: [
    {
      layer: "semantic",
      method: "direct_get",
      target: "sem-preference",
      query: null,
      purpose: "resolve preference",
    },
  ],
  confidence: 0.8,
  reason_codes: ["CURRENT_CONTEXT_INSUFFICIENT"],
};

const request = {
  currentMessage: "Help with a synthetic decision",
  recentContext: [],
  stateViewVersion: "view-1",
  activeGoverningSystem: "cog-governing",
  syncGeneration: "generation-1",
  expectedRegistryChecksum: checksum("a"),
  registry: {
    checksum: checksum("a"),
    entries: [
      { id: "state-synthetic", role: "current_state", version: "1", syncGeneration: "generation-1", checksum: checksum("1") },
      { id: "cog-governing", role: "governing_system", version: "3", syncGeneration: "generation-1", checksum: checksum("2") },
      { id: "cog-module", role: "governing_module", version: "1", syncGeneration: "generation-1", checksum: checksum("3"), governedBy: "cog-governing" },
      { id: "cog-method", role: "ordinary_framework", version: "1", syncGeneration: "generation-1", checksum: checksum("4") },
      { id: "sem-preference", role: "semantic", version: "1", syncGeneration: "generation-1", checksum: checksum("5") },
    ],
  },
};

test("router accepts one JSON-only host completion against the fixed registry", async () => {
  let calls = 0;
  const router = new StrictRouter({
    complete: async () => {
      calls += 1;
      return JSON.stringify(result);
    },
  });

  assert.deepEqual(await router.route(request), { status: "ok", result });
  assert.equal(calls, 1);
});

test("router degrades malformed output without retry or natural-language extraction", async () => {
  let calls = 0;
  const router = new StrictRouter({
    complete: async () => {
      calls += 1;
      return `Here is the result: ${JSON.stringify(result)}`;
    },
  });

  assert.deepEqual(await router.route(request), {
    status: "degraded",
    reasonCode: "ROUTER_NON_JSON_OUTPUT",
  });
  assert.equal(calls, 1);
});

test("router rejects governing, role, generation, version, and checksum drift", async () => {
  const cases = [
    [{ ...request, activeGoverningSystem: "cog-other" }, "ROUTER_GOVERNING_BINDING_MISMATCH"],
    [{ ...request, registry: { ...request.registry, entries: request.registry.entries.map((entry) => entry.id === "cog-method" ? { ...entry, role: "semantic" } : entry) } }, "ROUTER_ROLE_MISMATCH"],
    [{ ...request, syncGeneration: "generation-2" }, "ROUTER_GENERATION_MISMATCH"],
    [{ ...request, registry: { ...request.registry, entries: request.registry.entries.map((entry) => entry.id === "cog-governing" ? { ...entry, version: "2" } : entry) } }, "ROUTER_VERSION_MISMATCH"],
    [{ ...request, expectedRegistryChecksum: checksum("b") }, "ROUTER_REGISTRY_CHECKSUM_MISMATCH"],
  ];

  for (const [input, reasonCode] of cases) {
    const router = new StrictRouter({ complete: async () => JSON.stringify(result) });
    assert.deepEqual(await router.route(input), { status: "degraded", reasonCode });
  }
});

test("router timeout is bounded and does not retry", async () => {
  let calls = 0;
  const router = new StrictRouter({
    timeoutMs: 5,
    complete: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return JSON.stringify(result);
    },
  });

  assert.deepEqual(await router.route(request), {
    status: "degraded",
    reasonCode: "ROUTER_TIMEOUT",
  });
  assert.equal(calls, 1);
});

test("router permits no governing selection when the fixed binding is null", async () => {
  const router = new StrictRouter({
    complete: async () => JSON.stringify({
      ...result,
      governing: null,
      frameworks: { primary: null, secondary: null },
      retrieval_plan: [],
    }),
  });
  const outcome = await router.route({
    ...request,
    activeGoverningSystem: null,
  });
  assert.equal(outcome.status, "ok");
});
