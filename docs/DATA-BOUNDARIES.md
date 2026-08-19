# Data boundaries

Stella Runtime separates code, durable private authority, and live operational
state. Crossing these boundaries changes authority semantics and is unsupported.

| Owner | Contains | Must never contain |
| --- | --- | --- |
| Runtime repository and npm package | Generic source, contracts, adapter, CLI, Skill, synthetic fixtures, compatibility evidence | Private identity, knowledge, conversations, credentials, live databases, real experience records |
| Authority Repository | Private knowledge, identity, configuration, package pin, migration intent | Copied Runtime source or live Runtime databases |
| Git-external Runtime State | Current State ledger/head, unfinished correction and outbox state, protected Candidate admission/Receipt records, rebuildable projections, minimized overlays | Source-code authority or credentials |

The Authority Repository is the durable knowledge authority. A generation,
registry, index, cache, or embedding is a disposable checksummed projection.
Model output never promotes itself into Evidence, Semantic, Cognitive, or Current
State authority.

Discovery Authorization, Candidate revisions, Confirmation Requests, Telegram
message bindings, decisions, and Approval Receipt consumption remain in the
configured Runtime storage under `candidate-admission/`. The directory is mode
`0700`, its SQLite database is mode `0600`, and publication serializes Receipt
preparation/finalization with `BEGIN IMMEDIATE`. Telegram actor, account, chat,
and message metadata may exist there, but must not enter Authority Git, public
trace output, commit metadata, or the Runtime package.
Before publication claims a Receipt, workflow end, rewrite, or authorization
expiry invalidates it. A successful prepare CAS durably claims one exact Change
Set; later recovery may only finish that same publication and consume the
Receipt, never rebind or invalidate it halfway through an Authority commit.

## Recovery boundary

A Runtime Recovery Snapshot contains only Authoritative Runtime State required
to preserve current meaning or finish a committed correction. It excludes
rebuildable generations, raw experience, logs, credentials, private authority
documents, and host session internals. The orchestrator transports the opaque
snapshot and calls `backup`, read-only `verify`, and rollback-safe `restore`; it
must never copy a live SQLite file or depend on table layout.

## Public evidence

Repository tests, CI logs, release attestations, npm content, and examples use
synthetic data only. Optional consumer Instance Test Packs execute locally and
must never be uploaded, copied into this repository, or made a release gate.
