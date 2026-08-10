# Stella Runtime project background

## Why this repository exists

Stella began as a private OpenClaw Agent whose knowledge, configuration, and
operational tooling lived beside a personal data repository. The V1 redesign
separates the reusable cognitive engine from that private instance so the engine
can be developed, tested, packaged, and upgraded independently.

This repository is the public implementation authority for that reusable engine.
It must remain useful to arbitrary private instances without embedding the
identity, data, beliefs, paths, credentials, or real conversations of any one
instance.

## Product objective

The Runtime should let a private Agent use explicitly governed, versioned
personal knowledge while preserving five guarantees:

1. current user input outranks stale state and historical patterns;
2. authoritative knowledge is distinct from derived projections and model
   inference;
3. each Run sees one immutable state view and one active generation;
4. evidence use, cognitive role, and corrections are traceable;
5. an explicit correction affects a new Run and can be retried safely without
   silently rewriting history.

Product usefulness is ultimately judged by the private user. Automated tests
establish correctness and traceability; they do not substitute for that judgment.

## Frozen public identity

| Surface | Value |
| --- | --- |
| Project | Stella Runtime |
| GitHub | `tower1229/Stella-Runtime` |
| npm | `@tower1229/stella-cognitive-runtime` |
| OpenClaw Plugin ID | `cognitive-runtime` |
| Plugin config root | `plugins.entries.cognitive-runtime` |
| Schema namespace | `cognitive-runtime.<contract>/v1` |
| License | MIT |
| Node.js engines | `^22.19.0 || ^24.0.0` |

The project and npm names may use the Stella brand. Public protocol keys and
schemas use `cognitive-runtime.*`; `stella.*` is not a canonical public namespace.

## Three ownership layers

| Layer | Owns | Must not own |
| --- | --- | --- |
| Stella Runtime repository | Generic Plugin source, contracts and generated types, CLI, framework-admission Skill, compatibility manifest, authoritative-state recovery contract, synthetic tests, package and release automation | Personal facts, private Agent identity, real conversations, credentials, instance paths, live databases |
| Private authority repository | Durable personal knowledge, Agent identity and configuration, Runtime version pin, migration maps, de-identified instance tests, restore intent and private migration artifacts | Generic Runtime source, copied public contracts, forked public test Runner, live secrets in ordinary Git files |
| Git-external runtime storage | Current State events, immutable state views, generated registries and indexes, traces, raw experience records | Canonical source code, a replacement for the authority repository |

The private authority repository is the durable backup source for knowledge and
configuration. Cross-host reconstruction additionally uses an immutable private
migration artifact. Stella Runtime must contribute a Runtime Recovery Snapshot
for its Authoritative Runtime State; OpenClaw sessions, credentials, provider or
channel authentication, and service-manager state remain separate migration
classes with their own capture or reconstruction contracts.

The Runtime owns snapshot semantics and storage migration. The authority
repository's migration tooling may invoke `backup`, `verify`, and `restore`, but
must not copy a live database or understand its tables. Rebuildable generations,
registries, indexes, caches, traces, logs, and raw experience records are excluded
from the required authoritative snapshot unless a future contract explicitly
promotes one of them.

## V1 runtime shape

The vertical path is:

```text
authority revision + Current State events
  -> immutable State View and Active Generation
  -> always-bound governing context + one bounded Router decision
  -> progressive explicit context packet + host memory retrieval
  -> host Agent answer + cognitive provenance
  -> explicit correction transaction
  -> distinct successor Run with a new View
```

OpenClaw continues to own the Agent loop, sessions, memory/index facilities, and
native audit trajectory. Stella Runtime integrates through verified Plugin APIs;
it does not build a second Agent loop, vector database, or general trace system.

## Initial host compatibility baseline

Compatibility is declared by release channel, exact version, and real capability
smoke. An unlisted exact version is unsupported until its own matrix row passes.

| Channel | Exact version | Typed hooks | `llm.complete` | Memory refs | Run context round-trip | Native structured output | Embedded admission | Host next-turn injection | Command successor | UI normal-RPC successor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| extended-stable | `2026.6.34` | pass | pass | pass | fail | unavailable | fail | fail | pass | pass |

Consequences for the first adapter:

- use one bounded `RunScratchMap` keyed only by `run_id`; do not use
  `api.runContext.*` or fall back to `sessionKey`;
- request one JSON-only host-owned completion and perform strict local schema and
  registry validation; do not claim native structured output;
- implement re-answer delivery through a SQLite outbox with compare-and-set plus
  the host's normal command continuation or UI RPC path;
- do not call unadmitted embedded work, bundled-only scheduling, or unverified
  next-turn injection.

## Migration and release contract

The future private-instance cutover must be staged and reversible:

1. build and test a package from this repository using synthetic fixtures;
2. install the exact package version and pin it in the authority repository;
3. validate private instance configuration and de-identified instance tests;
4. export and verify a Runtime Recovery Snapshot while the source instance is in
   a consistent state;
5. restore and verify that snapshot on the target before serving a new Run;
6. run in `observe` mode without injecting private cognitive context;
7. rebuild and checksum a generation from one authority revision;
8. switch the private main-session boundary to `enforce` only after all gates pass;
9. preserve the pre-cutover configuration and index path for one rollback;
10. after acceptance, remove the old implementation instead of maintaining a
   permanent parallel architecture.

Code rollback installs the last verified package version. Data rollback restores
the pre-cutover host configuration and index path. Neither rollback rewrites the
authority repository or discards append-only Current State events.

## Public safety and acceptance gates

- Repository and npm tarball sensitive-content scans return zero findings.
- All examples and Golden fixtures are synthetic.
- Package exports point to built JavaScript, never machine-local TypeScript.
- Contracts fail deterministically on invalid IDs, broken references, wrong
  authority levels, missing required cognitive boundaries, or mixed generations.
- `npm pack` installation, Plugin inspect, CLI discovery, Skill discovery, and
  exact-host capability smoke pass before any beta publish.
- The Runtime repository never requires access to the private authority corpus in
  its CI or release process.
- Recovery export is transactionally consistent, versioned, checksummed, free of
  credentials, and verified before the source snapshot is accepted.
- Restore rejects incompatible schema/package/contract versions, is rollback-safe,
  and proves authoritative state continuity before a target serves a new Run.

## Requirement handoff and work tracking

The implementation sequence is tracked in this repository's GitHub Issues:

1. [#1: buildable single-package repository scaffold](https://github.com/tower1229/Stella-Runtime/issues/1);
2. [#2: `contracts/v1`, authority parser, and verified host ports](https://github.com/tower1229/Stella-Runtime/issues/2);
3. [#3: generic test Runner with an external instance-test seam](https://github.com/tower1229/Stella-Runtime/issues/3);
4. [#4: pack-install and exact-host smoke](https://github.com/tower1229/Stella-Runtime/issues/4).
5. [#5: authoritative Runtime state export, verification, and restore](https://github.com/tower1229/Stella-Runtime/issues/5)
   follows after the recovery contract is frozen.

Private-instance configuration, migration maps, deployment, rollback evidence,
and product acceptance remain tracked in the private authority repository. Public
issues may depend on private acceptance gates, but must describe the dependency
without copying private data or logs.

## Additional handoff work still required

Beyond moving the first implementation issues and adding this context, a complete
handoff needs these follow-up deliverables:

1. **Consumer contract**: a machine-readable private-instance version pin that
   records package version, contract version, OpenClaw matrix row, and checksums.
2. **Cross-repository CI seam**: public Runner accepts an external instance test
   directory; private CI invokes it without uploading private fixtures.
3. **Release integrity**: protected release workflow, npm provenance/trusted
   publishing, tarball allowlist, dependency review, and rollback version policy.
4. **Backup and restore integration**: connect the accepted Runtime Recovery
   Snapshot contract to the private migration orchestrator without exposing
   Runtime storage internals.
5. **Migration rehearsal**: test `off -> observe -> enforce -> rollback` against a
   non-production clone before touching the live private Agent.
6. **Compatibility ownership**: every supported OpenClaw exact version receives a
   committed matrix row and reproducible smoke evidence; rolling docs alone never
   expand support.
7. **Decision synchronization**: hard-to-reverse public protocol decisions become
   ADRs here; private instance decisions remain in the authority repository, with
   links instead of duplicated specifications.

## Historical design evidence

The architectural interview, host spike, and naming decision were completed in
the private authority project before this repository was created. They remain the
historical evidence for the first implementation slice. This public document is
the sanitized handoff baseline; it intentionally contains no private knowledge,
runtime logs, credentials, or real experience data.
