import assert from "node:assert/strict";
import test from "node:test";

import {
  admitFramework,
  calculateCognitiveAuthorityChecksum,
} from "../../dist/admission/index.js";
import { cognitiveMarkdown } from "../helpers/synthetic-authority.mjs";

const proposal = (decision, authorityMarkdown = undefined) => ({
  sourceAuthor: {
    sourceRefs: ["src-synthetic-note"],
    claims: ["A synthetic author claim."],
  },
  modelSynthesis: "The model suggests testing assumptions.",
  userUnderstanding: {
    decision,
    statement: decision === "rewritten"
      ? "I use this to test important assumptions, within explicit boundaries."
      : "I accept this bounded synthetic method.",
    ...(authorityMarkdown === undefined || decision === "rejected" ? {} : {
      confirmedAuthorityChecksum: calculateCognitiveAuthorityChecksum(authorityMarkdown),
    }),
  },
  ...(authorityMarkdown === undefined ? {} : { authorityMarkdown }),
});

test("accepted and rewritten understanding admit only a complete confirmed Cognitive Entity", () => {
  const accepted = admitFramework(proposal("accepted", cognitiveMarkdown()));
  assert.equal(accepted.status, "admitted");
  assert.equal(accepted.decision, "accepted");
  assert.equal(accepted.confirmedUnderstanding, "I accept this bounded synthetic method.");
  assert.equal(accepted.record.id, "cog-synthetic-method");

  const rewrittenMarkdown = cognitiveMarkdown().replace(
    "A synthetic method for evaluating claims.",
    "The user's rewritten synthetic method.",
  );
  const rewritten = admitFramework(proposal("rewritten", rewrittenMarkdown));
  assert.equal(rewritten.status, "admitted");
  assert.equal(rewritten.decision, "rewritten");
  assert.match(rewritten.confirmedUnderstanding, /within explicit boundaries/);
  assert.match(rewritten.record.sections.get("User definition"), /rewritten/);
});

test("rejected understanding never produces Cognitive authority", () => {
  assert.deepEqual(admitFramework(proposal("rejected")), {
    status: "rejected",
    decision: "rejected",
  });
});

test("missing Cognitive fields and raw Evidence promotion fail closed", () => {
  assert.throws(
    () => admitFramework(proposal("inferred")),
    /ADMISSION_DECISION_INVALID/,
  );
  assert.throws(
    () => admitFramework(proposal("accepted")),
    /ADMISSION_AUTHORITY_MARKDOWN_REQUIRED/,
  );
  const candidate = cognitiveMarkdown();
  assert.throws(
    () => admitFramework({
      ...proposal("accepted", candidate),
      userUnderstanding: {
        decision: "accepted",
        statement: "I accept some unspecified method.",
        confirmedAuthorityChecksum: `sha256:${"0".repeat(64)}`,
      },
    }),
    /ADMISSION_CONFIRMATION_MISMATCH/,
  );
  assert.throws(
    () => admitFramework(proposal(
      "accepted",
      cognitiveMarkdown().replace(
        "## Runtime digest\nTest important claims against counterexamples.",
        "",
      ),
    )),
    /ADMISSION_COGNITIVE_INVALID:MISSING_REQUIRED_SECTION/,
  );
  assert.throws(
    () => admitFramework(proposal("accepted", `---
schema_version: cognitive-runtime.evidence/v2
source_id: src-synthetic-note
source_type: user_note
created_at: { value: 2026-08-11, precision: day }
imported_at: { value: 2026-08-11, precision: day }
sensitivity: private
allowed_scenarios: [private_main_session]
not_allowed_scenarios: []
quote_policy: paraphrase_only
status: curated_summary
tags: []
media: []
---
Raw evidence.`)),
    /ADMISSION_COGNITIVE_REQUIRED/,
  );
});
