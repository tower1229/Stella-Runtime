---
name: framework-admission
description: Admit a proposed reasoning framework into Cognitive authority only after explicit user confirmation.
metadata:
  package: "@tower1229/stella-cognitive-runtime"
  package_version: 0.1.0-beta.0
---

# Framework Admission

Use this Skill when a user wants to evaluate, accept, reject, or rewrite a
reasoning framework for an Authority Repository. Keep three records visibly
separate throughout the conversation:

1. **Source author** — quote or accurately paraphrase the source author's claims
   and retain the stable Evidence source references.
2. **Model synthesis** — label the model's interpretation as synthesis, including
   uncertainty and possible disagreement. It is not authority.
3. **User understanding** — after the complete candidate entity exists, show its
   stable checksum and ask the user to mark that exact candidate `accepted`,
   `rejected`, or `rewritten`, recording the user's own bounded understanding.

Do not write an authority file for `rejected`. For `accepted` or `rewritten`,
prepare a `cognitive-runtime.cognitive/v1` Markdown record, calculate its stable
checksum with the installed Runtime package's `calculateCognitiveAuthorityChecksum`
export, and obtain confirmation of that checksum. Validate the candidate and
confirmation through `admitFramework` before presenting it for the consumer's
explicit write step. A rewrite changes the checksum and requires confirmation
again. The final entity must include non-empty:

- user definition and core propositions;
- direction and active attention;
- observational strengths;
- compression tendencies and blind spots;
- applicable and inapplicable boundaries;
- cognitive signature and operators;
- relations and tensions;
- positive examples, counterexamples, and calibration;
- source explanation and runtime digest.

A Governing System also requires a deterministic Persistent Kernel. A Governing
Module must name its Governing System. Preserve the confirmed entity's stable ID,
version, relations, and source references.

Raw Evidence, a framework name, source-author text, or model synthesis never
becomes Cognitive authority automatically. Never infer acceptance from silence,
enthusiasm, prior use, or a model-generated label. Do not copy or migrate private
knowledge into the Runtime package; write only to the Authority Repository that
the user explicitly selected.
