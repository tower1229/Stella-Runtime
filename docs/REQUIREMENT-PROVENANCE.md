# Requirement provenance and migrated decision basis

> Status: repository-local historical basis
> Last updated: 2026-08-11

This document records why the V1 requirements have their current shape and how
the pre-repository design artifacts were absorbed. It is historical evidence,
not a second specification. The historical `0.1.0` requirements and architecture
live in [`requirements/V1.md`](requirements/V1.md) and
[`architecture/V1.md`](architecture/V1.md). Current `0.2.x` authority lives in
the domain glossary, v2 data contracts, accepted ADRs, exact-host evidence, and
the completed roadmap extension.

Future Runtime work must not consult the original private-instance repository.
All generic conclusions needed to challenge or implement V1 are preserved here,
in the exact-host evidence, in ADRs, and in the normative documents.

## 1. Original problem

The original private Agent mixed reusable cognitive orchestration with personal
knowledge, instance configuration, generated projections, live state, and
operational scripts. That made it difficult to distinguish reusable software
behavior from one person's data and made upgrades, public testing, package
distribution, and cross-host reconstruction unsafe.

The architecture interview therefore pursued two simultaneous goals:

1. preserve a user's explicit authority, correction rights, temporal continuity,
   and data portability;
2. extract an instance-neutral Runtime that can be understood, implemented,
   tested, packaged, and released without private assets.

## 2. Decision basis

### Current expression outranks stored interpretation

Long-term knowledge helps continuity but can become a stale identity trap. The
Runtime therefore treats current explicit input as higher authority than Current
State, historical Semantic claims, and Personal Model interpretations. Personal
Model remains conditional and falsifiable.

### Explicit authority outranks latent representation

Embeddings, indexes, digests, registries, and generations are useful for runtime
performance but are difficult for a user to inspect and correct. They remain
versioned projections of explicit authority and can always be deleted and rebuilt.

### Cognitive frameworks require admission

A framework name can import an author's meaning or a model's prior and falsely
attribute it to a user. Admission separates author claims, model synthesis, and
user confirmation. The public Runtime defines the process and shape, never the
content of a concrete worldview.

### One bounded Router beats an agentic pre-router

An iterative planner before the real Agent loop would duplicate orchestration,
increase latency, and obscure failure. V1 uses one bounded host-owned completion,
strict local validation, no tools, and no retries. OpenClaw remains the only Agent
loop.

### Governing context and ordinary frameworks are different roles

An instance may declare zero or one Governing System whose Kernel is always bound
for eligible Runs. Ordinary frameworks compete only for specific cognitive jobs.
This prevents a Router from silently dropping or replacing a user's explicitly
configured governing direction while keeping the public protocol worldview-free.

### Immutable Run views prevent temporal tearing

If a correction changed an in-flight Run's state, one response could combine old
and new meanings. Each Run therefore pins one State View and generation. A
correction commits new authority and is observed only by a distinct successor Run.

### Outbox delivery preserves host ownership

The first host did not provide a verified persisted-session embedded-work
admission or reliable next-turn injection. Direct runner calls or session-store
writes would race the host's queue and lock. Runtime owns a correction outbox;
command continuation or an explicit UI normal RPC lets OpenClaw create the Run.

### Minimal provenance avoids a second audit system

OpenClaw already owns execution trajectory. Copying prompts, answers, and tool
payloads would increase privacy risk and create duplicate audit truth. Runtime
stores only cognitive role and stable-reference overlay data linked by `run_id`.

### Runtime owns recovery semantics

Copying a live database cannot guarantee a consistent boundary and exposes
storage internals to every migration caller. A small `backup / verify / restore`
interface hides consistency, version compatibility, internal schema migration,
and rollback while giving recovery orchestrators a stable opaque artifact.

### Repository autonomy is a release requirement

If generic implementation issues still point at a consumer's design files, the
software remains organizationally coupled even after source extraction. The
Runtime repository therefore owns requirements, architecture, decisions, host
evidence, roadmap, source, tests, and release. Consumers provide only optional
Instance Test Packs and recovery orchestration.

## 3. Exact-host evidence classes

The initial design used four evidence classes:

1. **published host contract**: official Plugin, hook, Agent-loop, queue, and
   release-channel documentation;
2. **installed exact-version surface**: package types and runtime exports from the
   frozen extended-stable build;
3. **synthetic focused smoke**: hook correlation, completion, memory refs,
   scratch lifecycle, transaction/outbox, command successor, UI successor, abort,
   retry, cleanup, and configuration restoration;
4. **negative evidence**: declared but unverified or non-functional paths were
   recorded as unsupported instead of inferred from types or later documentation.

The resulting capability matrix and rejected adapter paths are preserved in
[`evidence/openclaw-2026.6.34.md`](evidence/openclaw-2026.6.34.md).

## 4. Rejected or superseded routes

- a second Direct/Agentic top-level runtime path;
- a multi-step planning or tool-using Router;
- framework names or model inference as user authority;
- generated projections as a second knowledge source;
- `sessionKey` as concurrent Run correlation fallback;
- repeated Router completion or permissive JSON extraction;
- direct unadmitted persisted-session embedded runs;
- bundled-only scheduling from an external Plugin;
- unverified host next-turn injection;
- cross-Run exactly-once delivery claims;
- copying live SQLite for backup;
- maintaining old and new Runtime implementations as permanent fallbacks;
- splitting Plugin, CLI, contracts, and Framework Admission into independent
  version lines;
- making a private consumer repository a Runtime specification or release gate.

## 5. Migrated artifact coverage

The pre-repository control plane contained six artifact roles. Their generic
content is now owned as follows:

| Historical role | Repository-local replacement |
| --- | --- |
| interview recovery entry | README start links, roadmap dependency order, GitHub issue state |
| mutable task-state file | `docs/roadmap/V1.md` plus GitHub #1–#10 |
| data architecture specification | `docs/requirements/V1.md` and `docs/architecture/V1.md` |
| interview decision ledger | this file, `CONTEXT.md`, and `docs/adr/` |
| legacy contract compatibility matrix | DS-04 requirements, contracts issue #2, schema fixtures |
| complete V1 implementation plan | `docs/architecture/V1.md` and `docs/roadmap/V1.md` |
| exact-host feasibility research | `docs/evidence/openclaw-2026.6.34.md` |

The historical source files may remain reachable through version-control history,
but they are superseded and are not required inputs to any Runtime task.

## 6. Change rule

New generic requirements are changed here first through the normative document,
an ADR when the decision is hard to reverse, and an executable Runtime issue.
Consumer-specific deployment or private-data decisions stay outside this
repository and cannot silently modify the public protocol.
