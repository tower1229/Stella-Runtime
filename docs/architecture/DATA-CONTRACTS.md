# Stella Runtime V2 data contracts

> Status: normative logical contract baseline
> Serialization authority: generated JSON Schema in `contracts/v2`

This document freezes the coherent logical V2 shapes and invariants that issue #12 must
express as JSON Schema, generated TypeScript types, runtime validation, and
positive and negative fixtures. Examples are synthetic and do not introduce new
enumerations beyond the schemas.

## 1. Compatibility rules

- Physical Markdown frontmatter remains flat; files are not forced into a nested
  `envelope` object.
- Evidence identity is `source_id`, Semantic identity is `claim_id`, and Cognitive
  identity is `cognitive_id`. Authority parsing maps them to logical `id`, `layer`,
  and `record_type` in memory.
- Directory structure may determine `layer`; legacy files need not duplicate it.
- Evidence `status` describes source-material handling, not authority lifecycle.
- V2 does not infer or serialize an unconfirmed general `lifecycle` field.
- Replacement is represented by forward `supersedes` links, entity version, source
  revision, and generation; history is never overwritten.
- Every stable reference resolves within one authority revision and every derived
  artifact carries the active `sync_generation`.

## 2. Evidence Source

One source is one directory package:

```text
<source-id>/
├── source.md
├── original/        # optional source originals
└── assets/          # optional relative media
```

Minimal synthetic frontmatter:

```yaml
schema_version: cognitive-runtime.evidence/v2
source_id: src-synthetic-note
source_type: user_note
created_at: { value: 2026-08, precision: month }
imported_at: { value: 2026-08-11T09:00:00+08:00, precision: instant }
sensitivity: private
allowed_scenarios: [private_main_session]
not_allowed_scenarios: [public_output]
quote_policy: paraphrase_only
status: curated_summary
tags: []
media:
  - id: media-primary
    path: assets/primary.png
    role: primary
    importance: high
    caption: Synthetic diagram
    salient: true
    visual_thesis: The synthetic flow is visibly ordered.
```

Invariants:

- source originals, normalized source text, and assets preserve provenance;
- model summaries, chunks, embeddings, indexes, and generated claims never write
  back into the source package;
- Evidence proves what a source contains; it does not define current fact,
  Personal Model, or Cognitive authority;
- relative asset references cannot escape the source package;
- temporal values declare `year`, `month`, `day`, or `instant` precision and the
  serialized value must match that precision;
- high-importance media requires a non-empty `visual_thesis`;
- scenario and quote policy are enforced before retrieval content is injected.

## 3. Semantic Claim

One file contains one independently correctable primary claim:

```yaml
schema_version: cognitive-runtime.semantic/v2
claim_id: sem-synthetic-preference
record_type: preference
aliases: []
scope:
  contexts: [writing]
  conditions: []
valid_time:
  from: 2026-08-11
  to: null
epistemic: user_explicit
confidence: high
source_refs: [src-synthetic-note]
related_claims: []
supersedes: []
created_at: 2026-08-11
updated_at: 2026-08-11
```

The Markdown body is the claim. `confidence` is an epistemic grade, not a numeric
probability. Unconfirmed model inference cannot enter formal Semantic authority.
Historical claims retain valid time. A revision that changes an independently
testable meaning creates a new claim with a forward `supersedes` link. Host
bootstrap files are projections, never edit surfaces.

## 4. Personal Model

Personal Model is a special Semantic record whose body is a conditional,
falsifiable hypothesis rather than an identity label:

```yaml
schema_version: cognitive-runtime.personal-model/v2
claim_id: pm-synthetic-feedback-pattern
record_type: personal_model
scope:
  contexts: [high_uncertainty_decision]
  conditions: [long_feedback_delay]
epistemic: user_confirmed_hypothesis
confidence: medium
source_refs: [src-synthetic-a, src-synthetic-b]
counterevidence_refs: [src-synthetic-c]
competing_explanations: [temporary_fatigue]
revision_triggers: [repeated_counterexample]
supersedes: []
created_at: 2026-08-11
updated_at: 2026-08-11
```

The body and metadata must express conditions, scope, evidence, counterevidence or
a competing explanation, and revision triggers. Essentialized statements such as
"the user is inherently X" fail lint. Runtime may use the record only as a
qualified interpretation and cannot silently create, rewrite, or delete it.

## 5. Cognitive Entity

Each entity has one hand-written authority entry `entity.md`:

```yaml
schema_version: cognitive-runtime.cognitive/v2
cognitive_id: cog-synthetic-method
entity_type: epistemic_method
entity_version: 1
title: Synthetic reliability method
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
```

The body requires these non-empty sections:

```text
## User definition
## Core propositions
## Direction and active attention
## Observational strengths
## Compression tendencies and blind spots
## Applicable and inapplicable boundaries
## Cognitive signature
## Cognitive operators
## Relations and tensions
## Positive examples, counterexamples, and calibration
## Runtime digest
## Source explanation
```

A Governing System additionally requires `## Persistent Kernel`. Builder extracts
that section deterministically and never calls a model to reinterpret it during
sync. Governing Modules are independent entities. An ordinary framework cannot
become a Module through Router configuration.

## 6. Cognitive Binding

Binding contains identity only, never framework content:

```yaml
schema_version: cognitive-runtime.cognitive-binding/v2
active_governing_system: null
```

`active_governing_system` is `null` or one stable Cognitive ID. Runtime schemas,
source, prompts, and fixtures never contain a concrete worldview as a constant.
The Router may select declared Modules but cannot change or clear the binding.

## 7. Router result

Synthetic logical result:

```json
{
  "memory_route": "required",
  "state_refs": ["state-synthetic"],
  "governing": {
    "system": "cog-synthetic-governing",
    "kernel_version": "1",
    "modules": ["cog-synthetic-module"]
  },
  "frameworks": {
    "primary": "cog-synthetic-method",
    "secondary": null
  },
  "retrieval_plan": [
    {
      "layer": "semantic",
      "method": "direct_get",
      "target": "sem-synthetic-preference",
      "query": null,
      "purpose": "resolve current synthetic preference"
    }
  ],
  "confidence": 0.9,
  "reason_codes": ["CURRENT_CONTEXT_INSUFFICIENT"]
}
```

The closed schema rejects extra fields and free-text chain-of-thought. Semantic
validation rejects inactive IDs, changed governing binding, more than two
Modules, more than one primary and one secondary ordinary framework, more than
six retrieval steps, `direct_get` without a stable target, `search` without a
query, role mismatch, or generation/version/checksum drift.

## 8. Current State Event and head

Logical Event fields:

```text
seq, event_id, state_id, event_type, payload, observed_at,
source_kind, source_ref?, corrects_event_id?, supersedes_event_id?,
idempotency_key, created_at
```

Logical head fields:

```text
active_seq, view_version, checksum, activated_at
```

Events are insert-only; database guards reject update and delete. The head marks
the activated event boundary and contains no duplicate state body. View reduction
is deterministic; version derives from the event boundary and canonical content
hash. Time passage and model inference cannot create state changes. Event append,
head activation, and correction outbox creation share one transaction.

Semantic and Cognitive revisions never enter the Current State Event Ledger.

## 9. ReanswerOutbox

The logical record contains:

```text
correction_id, instance_id, session_key_hash, prior_run_id,
new_view_version, status, attempt_count, successful_completion_count,
successor_run_id?, last_error_code?, idempotency_key, created_at, updated_at
```

Valid progression is `pending -> in_flight -> completed`; failure or abort may
move `in_flight -> pending`. Each session has at most one non-terminal record.
Each attempt uses CAS. `successful_completion_count` never exceeds one. A repeated
idempotency key returns the existing record and does not start a new continuation.

## 10. Cognitive Provenance Overlay

Logical fields:

```text
trace_id, run_id, session_key_hash, sync_generation,
knowledge_snapshot, state_view_version, validated_router_result,
cognitive_bindings, stable_refs, unresolved_conflicts,
trace_status, eval_eligible, created_at
```

Stable refs distinguish `planned`, `retrieved`, `injected`, `declared_used`, and
`declared_excluded`. `declared_used` is only a model declaration; Runtime does not
claim access to hidden attention or chain-of-thought. The overlay never stores the
full prompt, answer, tool payload, credentials, or personal document body.

## 11. Recovery manifest and report

The manifest includes:

```text
snapshot_schema_version, storage_schema_version, package_version,
contract_version, instance_id, authority_revision, active_seq,
state_view_version, files[{path, size, checksum}], pending_outbox_summary,
created_at
```

The V2 verification/restore report requires authority revision alongside
compatibility result, integrity result, restored active head, pending outbox
state, storage migrations applied, rollback result, and projections requiring
rebuild. The report never exposes credentials, private
bodies, database table names, or live database paths.

## 12. Runtime 0.2 contracts

The same Contract Set also defines bounded discovery authorization, immutable
Candidate revisions and review artifacts, deterministic Decision/Approval
Receipts, Change Sets, State import/correction/view documents, Generation and
Projection identity, Active Generation pointers, Activation Receipts, Instance
Runtime Config, and Instance Cutover Plans. Each schema has a
`cognitive-runtime.<contract>/v2` identity and rejects unknown top-level fields.

## 13. Contract evolution

Schemas under `contracts/v2` are the executable authority. V1 was never formally
activated and has no reader, alias, or parallel public path. A future change that alters
meaning, required fields, accepted values, identity, authority role, or state
transition requires a new compatible schema revision or contract namespace,
fixtures for old and new forms, explicit migration, and a documented refusal path.
