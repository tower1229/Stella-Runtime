import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const cognitiveSections = [
  ["User definition", "A synthetic method for evaluating claims."],
  ["Core propositions", "Claims should be tested against independent evidence."],
  ["Direction and active attention", "Look for disconfirming observations."],
  ["Observational strengths", "Makes assumptions visible."],
  ["Compression tendencies and blind spots", "Can underweight time constraints."],
  ["Applicable and inapplicable boundaries", "Useful for review, not emergency triage."],
  ["Cognitive signature", "Compare a claim with a counterexample."],
  ["Cognitive operators", "List assumptions and test the weakest one."],
  ["Relations and tensions", "Complements direct observation."],
  ["Positive examples, counterexamples, and calibration", "A counterexample can narrow a claim."],
  ["Runtime digest", "Test important claims against counterexamples."],
  ["Source explanation", "Derived from the synthetic note and confirmed by the synthetic user."],
];

export const cognitiveMarkdown = ({
  id = "cog-synthetic-method",
  entityType = "epistemic_method",
  governedBy = null,
  sourceRefs = ["src-synthetic-note"],
  extraSections = [],
} = {}) => `---
schema_version: cognitive-runtime.cognitive/v2
cognitive_id: ${id}
entity_type: ${entityType}
entity_version: 1
title: Synthetic method
aliases: []
cognitive_jobs: [evaluate_claim_reliability]
route_signals: [verify_claim]
relations:
  governed_by: ${governedBy ?? "null"}
  parent: null
  complements: []
  tensions: []
source_refs: [${sourceRefs.join(", ")}]
confirmed_at: 2026-08-11
updated_at: 2026-08-11
---
${[...cognitiveSections, ...extraSections]
  .map(([title, content]) => `## ${title}\n${content}`)
  .join("\n\n")}
`;

export async function writeSyntheticAuthority(root, options = {}) {
  await mkdir(join(root, "evidence", "src-synthetic-note"), { recursive: true });
  await mkdir(join(root, "semantic"), { recursive: true });
  await mkdir(join(root, "cognitive", "cog-synthetic-method"), { recursive: true });
  await writeFile(join(root, "evidence", "src-synthetic-note", "source.md"), `---
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
A synthetic note.
`);
  await writeFile(join(root, "semantic", "claim.md"), `---
schema_version: cognitive-runtime.semantic/v2
claim_id: sem-synthetic-claim
record_type: fact
aliases: []
scope: { contexts: [review], conditions: [] }
valid_time: { from: 2026-08-11, to: null }
epistemic: user_explicit
confidence: high
source_refs: [src-synthetic-note]
related_claims: []
supersedes: []
created_at: 2026-08-11
updated_at: 2026-08-11
---
Synthetic claims can be tested.
`);
  await writeFile(
    join(root, "cognitive", "cog-synthetic-method", "entity.md"),
    options.cognitive ?? cognitiveMarkdown(),
  );
  await writeFile(
    join(root, "cognitive-binding.json"),
    `${JSON.stringify({
      schema_version: "cognitive-runtime.cognitive-binding/v2",
      active_governing_system: options.activeGoverningSystem ?? null,
    })}\n`,
  );
}

export async function commitSyntheticAuthority(root, message = "synthetic authority") {
  await execFileAsync("git", ["init", "--initial-branch=main", root]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "Synthetic Authority"]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "synthetic@example.invalid"]);
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", ["-C", root, "commit", "-m", message]);
  const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]);
  return stdout.trim();
}

export async function commitAuthorityChanges(root, message = "update synthetic authority") {
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", ["-C", root, "commit", "-m", message]);
  const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]);
  return stdout.trim();
}

export async function commitSyntheticPersonalDataRepository(
  repository,
  message = "synthetic personal data",
) {
  await execFileAsync("git", ["init", "--initial-branch=main", repository]);
  await execFileAsync("git", ["-C", repository, "config", "user.name", "Synthetic Authority"]);
  await execFileAsync("git", ["-C", repository, "config", "user.email", "synthetic@example.invalid"]);
  await execFileAsync("git", ["-C", repository, "add", ".gitignore", "stella/authority"]);
  await execFileAsync("git", ["-C", repository, "commit", "-m", message]);
  const { stdout } = await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"]);
  return stdout.trim();
}
