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
