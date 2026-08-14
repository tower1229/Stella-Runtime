---
status: accepted
---

# State initialization, import, and correction are distinct

Stella Runtime distinguishes an explicitly initialized empty Current State from
missing Runtime State, and distinguishes initial historical State Import from
runtime State Correction. They may share append-only storage machinery, but
Import produces an audited migration without successor responses, while
Correction advances the active head and requests a distinct successor Run; this
prevents migration from impersonating a user correction or creating a re-answer
storm. Import is permitted only after explicit State Initialization and before
the instance serves its first real Run; the entire validated batch commits
atomically, exact retries are idempotent, and one invalid event rejects the whole
batch.
Runtime State Correction is also distinct from ordinary conversation: a model
may prepare an exact Correction Preview, but only a deterministic user action
may issue the single-use State Correction Receipt that is consumed atomically
with the appended event, active-head advance, and successor outbox. The Receipt
binds instance, base State View, exact Event checksum, and host-scoped approval;
base drift rejects it, exact retries are idempotent, and successful correction
consumes it. Within the Local Trust Boundary, CLI correction instead uses a
two-step `plan` and `apply`: `plan` renders the complete Preview and checksum,
and `apply` requires that checksum and an unchanged base View before committing.
It needs neither a Telegram round trip nor a separate identity or Receipt system.
