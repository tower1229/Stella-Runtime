import assert from "node:assert/strict";
import test from "node:test";

import {
  lintAuthorityRecord,
  parseAuthorityMarkdown,
  resolveStableId,
} from "../../dist/authority/index.js";

const cognitiveSections = [
  "User definition",
  "Core propositions",
  "Direction and active attention",
  "Observational strengths",
  "Compression tendencies and blind spots",
  "Applicable and inapplicable boundaries",
  "Cognitive signature",
  "Cognitive operators",
  "Relations and tensions",
  "Positive examples, counterexamples, and calibration",
  "Runtime digest",
  "Source explanation",
];

const cognitiveMarkdown = (extraSection = "") => `---
schema_version: cognitive-runtime.cognitive/v1
cognitive_id: cog-synthetic-method
entity_type: epistemic_method
entity_version: 1
title: Synthetic method
aliases: []
cognitive_jobs: [evaluate_claim_reliability]
route_signals: []
relations:
  governed_by: null
  parent: null
  complements: []
  tensions: []
source_refs: [src-synthetic-note]
confirmed_at: 2026-08-11
updated_at: 2026-08-11
---
${cognitiveSections.map((section) => `## ${section}\nSynthetic ${section.toLowerCase()}.`).join("\n\n")}
${extraSection}`;

test("authority parser derives path-independent logical identity", () => {
  const first = parseAuthorityMarkdown(cognitiveMarkdown(), {
    sourcePath: "/authority/cognitive/one/entity.md",
  });
  const moved = parseAuthorityMarkdown(cognitiveMarkdown(), {
    sourcePath: "/authority/archive/renamed.md",
  });

  assert.equal(first.id, "cog-synthetic-method");
  assert.equal(first.id, moved.id);
  assert.equal(first.layer, "cognitive");
  assert.equal(first.recordType, "epistemic_method");
  assert.equal(lintAuthorityRecord(first).valid, true);
});

test("stable ID resolver rejects missing, duplicate, and wrong-layer references", () => {
  const cognitive = parseAuthorityMarkdown(cognitiveMarkdown());
  const semantic = parseAuthorityMarkdown(`---
schema_version: cognitive-runtime.semantic/v1
claim_id: sem-synthetic-preference
record_type: preference
aliases: []
scope: { contexts: [writing], conditions: [] }
valid_time: { from: 2026-08-11, to: null }
epistemic: user_explicit
confidence: high
source_refs: [src-synthetic-note]
related_claims: []
supersedes: []
created_at: 2026-08-11
updated_at: 2026-08-11
---
Concise responses are preferred.`);

  assert.equal(
    resolveStableId([cognitive, semantic], "sem-synthetic-preference", "semantic"),
    semantic,
  );
  assert.throws(
    () => resolveStableId([cognitive], "missing"),
    /STABLE_REF_NOT_FOUND/,
  );
  assert.throws(
    () => resolveStableId([cognitive], cognitive.id, "semantic"),
    /STABLE_REF_LAYER_MISMATCH/,
  );
  assert.throws(
    () => resolveStableId([cognitive, cognitive], cognitive.id),
    /DUPLICATE_STABLE_ID/,
  );
});

test("cognitive lint rejects empty required sections and governing systems without a kernel", () => {
  const emptyDigest = parseAuthorityMarkdown(
    cognitiveMarkdown().replace(
      "## Runtime digest\nSynthetic runtime digest.",
      "## Runtime digest\n",
    ),
  );
  assert.deepEqual(
    lintAuthorityRecord(emptyDigest).issues.map((issue) => issue.code),
    ["EMPTY_REQUIRED_SECTION"],
  );

  const governing = parseAuthorityMarkdown(
    cognitiveMarkdown().replace("epistemic_method", "governing_system"),
  );
  assert.deepEqual(
    lintAuthorityRecord(governing).issues.map((issue) => issue.code),
    ["MISSING_PERSISTENT_KERNEL"],
  );
});

test("personal-model lint rejects essentialized statements", () => {
  const record = parseAuthorityMarkdown(`---
schema_version: cognitive-runtime.personal-model/v1
claim_id: pm-synthetic-pattern
record_type: personal_model
scope: { contexts: [writing], conditions: [under_pressure] }
epistemic: user_confirmed_hypothesis
confidence: medium
source_refs: [src-synthetic-note]
counterevidence_refs: []
competing_explanations: [temporary_fatigue]
revision_triggers: [repeated_counterexample]
supersedes: []
created_at: 2026-08-11
updated_at: 2026-08-11
---
The user is inherently impatient.`);

  assert.deepEqual(
    lintAuthorityRecord(record).issues.map((issue) => issue.code),
    ["ESSENTIALIZED_PERSONAL_MODEL"],
  );
});
