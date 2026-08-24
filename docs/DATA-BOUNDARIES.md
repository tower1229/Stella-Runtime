# Data boundaries

Stella Runtime separates code, durable private authority, and live operational
state. Crossing these boundaries changes authority semantics and is unsupported.

| Owner | Contains | Must never contain |
| --- | --- | --- |
| Runtime repository | Generic source, contracts, adapters, CLI, Skill, synthetic fixtures, tests, compatibility evidence, and release automation | Private identity, knowledge, conversations, credentials, live databases, real experience records |
| npm package | Compiled Runtime, generated declarations, v2 schemas, compatibility manifest, selected documentation/evidence, Skill, and public Runner | Repository source/tests/scripts, synthetic fixture packs, private identity, knowledge, credentials, or live state |
| Authority Repository logical root `stella/authority/` | Private Runtime knowledge, identity, configuration, package pin, migration intent | Fitness canonical content, copied Runtime source, or live Runtime databases |
| Personal Data Repository `stella/fitness/` | Fitness-owned canonical working data | Runtime Authority or Runtime-owned projections |
| Personal Data Repository `stella/projections/` | Versioned producer-owned exchange projections | A second canonical source for Runtime or Fitness |
| Git-external Runtime State | Current State ledger/head, unfinished correction and outbox state, protected Candidate admission/Receipt records, rebuildable projections, minimized overlays | Source-code authority or credentials |

The Authority subtree is the durable Runtime knowledge authority. Read-only
validation scopes Git status/tree/blob operations to `stella/authority/` and
never reads or interprets `stella/fitness/`; Runtime consumes Fitness facts only
through the formal projection seam. A generation,
registry, index, cache, or embedding is a disposable checksummed projection.
Model output never promotes itself into Evidence, Semantic, Cognitive, or Current
State authority.

Authority publication receives only explicit Authority Change Set operations
and must never automatically stage or commit Fitness canonical data. A current
adapter may still require the entire controlled checkout to be clean. Until
Authority writes use an isolated worktree/index, that is a documented
publication limitation rather than complete single-repository write support.

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
