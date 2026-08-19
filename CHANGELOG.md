# Changelog

All notable public changes are recorded here. Versions follow Semantic
Versioning; cognitive contract namespaces remain independently versioned.

## [Unreleased]

- replaces the never-activated v1 protocol with one closed v2 Contract Set;
- adds v2 contracts for bounded Candidate approval, Change Sets, State,
  Generation/Projection identity, activation evidence, and instance cutover;
- preserves Evidence media and explicit year/month/day/instant precision without
  retaining a v1 reader or package export.
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

[0.1.0]: https://github.com/tower1229/Stella-Runtime/releases/tag/v0.1.0
