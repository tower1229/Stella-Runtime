# Changelog

All notable public changes are recorded here. Versions follow Semantic
Versioning; cognitive contract namespaces remain independently versioned.

## [Unreleased]

- adds separate composite Generation Manifest, Activation Receipt, and Active
  Generation Pointer v3 contracts that bind one Authority checksum and sorted
  verified domain projection tuples without changing v2 identity semantics;
- consumes the configured Fitness projection during sync and revalidates its
  pointer at both Eligible Run barriers while retaining one pinned Generation
  and State View per Run;
- replaces the Runtime-managed Fitness corpus as a complete revision-isolated
  desired set, records exact indexed counts and prior-value zero-hit evidence,
  and keeps destructive correction/deletion recovery gated until a non-leaking
  target completes;
- adds a pinned packed Fitness consumer to exact-host verification, proving F1
  to G1 and corrected F2 to distinct G2 consumption, lifecycle data retention,
  fail-closed locator loss, explicit locator restoration after reinstall, and
  the full recovery and replacement matrix without publishing either package.

## [0.2.1] - 2026-08-21

- adds a post-publish registry exact-host smoke that binds the installed npm
  artifact to the workflow tarball integrity and repeats discovery, Gateway,
  Generation Consumption, fail-closed, recovery, and restoration acceptance;
  stable automation now also publishes the complete version section as GitHub
  Release notes;
- recognizes exact private-session Gateway CLI Runs whose Host context omits a
  redundant sender field, and proves `before_agent_run` blocks before any final
  Agent model request;
- centralizes canonical JSON ordering, invalid-value policy, newline handling,
  equality, and checksums so identities cannot drift with locale or subsystem;
- corrects stable-release documentation, v2 protocol authority, exact CLI
  options, package boundaries, and the completed 0.2 implementation history.

## [0.2.0] - 2026-08-20

- replaces the never-activated v1 protocol with one closed v2 Contract Set;
- adds v2 contracts for bounded Candidate approval, Change Sets, State,
  Generation/Projection identity, activation evidence, and instance cutover;
- preserves Evidence media and explicit year/month/day/instant precision without
  retaining a v1 reader or package export.
- adds persistent Candidate confirmation and single-use Approval Receipt state
  across restart, serializes exact publication consumption, and recovers
  idempotently around Authority Git commits without exposing channel metadata.
- compiles one immutable Active Run Binding from the active Pointer, Activation
  Receipt, Generation, Host/config identity, and State View for each eligible
  private Run; removes inline static Binding configuration and fails closed in
  `enforce` when activation proof is missing, stale, or inconsistent.
- adds the public `sync` Activation Barrier with a durable Maintenance Gate and
  Sync Journal, exact Host/Projection/config/retrieval proof, verified prior-state
  recovery, Activation Receipt creation, and final atomic Active Pointer switch.
- connects `sync` to OpenClaw's supported per-Agent `memorySearch.extraPaths`,
  forced indexing, deep status, memory search, and Gateway `memory_get`
  interfaces, with durable path ownership and search/get sentinel validation.
- enforces checksummed Instance Cutover Plans through `sync`, including optional
  consumer-owned remote publication prerequisites, same-Barrier legacy path and
  mechanism removal, target-Generation Bootstrap deployment, independent Public
  Corpus continuity evidence, and a public de-identified CangHai fixture.
- accepts the packed `0.2.0` source target on exact OpenClaw `2026.6.34` and
  Node.js `24.18.0`, proving deterministic Telegram approval through Git
  publication, Generation sync, Host index/search/get, restart continuity, and
  next-Eligible-Run consumption, plus fail-closed recovery and drift gates.
- adds a public de-identified CangHai Instance Test Pack that the public Runner
  executes without exposing private instance state.
- adds startup, sync, drift-triggered, and periodic reconciliation health checks;
  recovered compatibility replaces stale or duplicate reason codes before new
  Eligible Runs reopen, while unresolved health keeps `enforce` fail closed.

## [0.1.0] - 2026-08-13

First stable technical release of Stella Runtime V1.

- ships the instance-neutral OpenClaw Plugin, public contracts, generated
  JavaScript and types, framework-admission Skill, and conformance Runner;
- adds immutable generation activation, bounded routing and packet assembly,
  Current State correction/outbox delivery, minimized provenance, and
  rollback-safe Runtime Recovery Snapshots;
- declares exact compatibility with OpenClaw extended-stable `2026.6.34`;
- verifies clean tarball install, Plugin/CLI/Skill discovery, host hooks,
  recovery, restart continuity, upgrade, rollback, integrity, and public-data
  boundaries using synthetic fixtures only.

[Unreleased]: https://github.com/tower1229/Stella-Runtime/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/tower1229/Stella-Runtime/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/tower1229/Stella-Runtime/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/tower1229/Stella-Runtime/releases/tag/v0.1.0
