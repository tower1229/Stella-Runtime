import assert from "node:assert/strict";
import test from "node:test";

import { buildExplicitContextPacket } from "../../dist/packet/index.js";

const binding = {
  currentInput: "Choose a synthetic option",
  stateView: [{ id: "state-synthetic", content: "Current synthetic state" }],
  semanticClaims: [{ id: "sem-synthetic", content: "Synthetic preference" }],
  evidenceRefs: [{ id: "src-synthetic", content: "Synthetic evidence" }],
  governing: {
    system: { id: "cog-governing", version: "1", content: "Synthetic kernel" },
    modules: [{ id: "cog-module", version: "1", content: "Synthetic module" }],
  },
  frameworks: [{ id: "cog-framework", version: "1", content: "Synthetic method" }],
  retrievalInstructions: ["Retrieve sem-synthetic"],
};

test("explicit packet preserves authority roles and configured governing kernel", () => {
  const packet = buildExplicitContextPacket({
    binding,
    memoryRoute: "none",
    maxCharacters: 2_000,
  });

  assert.match(packet, /\[current_input\]/);
  assert.match(packet, /\[current_state:state-synthetic\]/);
  assert.match(packet, /\[semantic:sem-synthetic\]/);
  assert.match(packet, /\[evidence:src-synthetic\]/);
  assert.match(packet, /\[governing_kernel:cog-governing@1\]\nSynthetic kernel/);
  assert.doesNotMatch(packet, /governing_module|ordinary_framework|retrieval_instruction/);
});

test("explicit packet rejects content beyond its configured boundary", () => {
  assert.throws(
    () => buildExplicitContextPacket({
      binding,
      memoryRoute: "required",
      maxCharacters: 80,
    }),
    /CONTEXT_PACKET_LIMIT_EXCEEDED/,
  );
});
