# Stella Runtime

Stella Runtime is an instance-neutral cognitive runtime for OpenClaw. It binds
explicit, versioned, traceable, and correctable knowledge to one host-owned Agent
Run without turning model inference or generated projections into hidden
authority.

> Stable release candidate: `0.2.0`; it is not yet published. The previous
> published rollback version is `0.1.0`. Compatibility is accepted only for
> OpenClaw extended-stable
> `2026.6.34` on Node.js `24.18.0`; compatibility is exact, not minimum-version
> based.

## What ships

The single package `@tower1229/stella-cognitive-runtime` contains:

- the OpenClaw Plugin `cognitive-runtime` and its operational CLI;
- versioned JSON Schemas plus generated JavaScript and TypeScript declarations;
- bounded Router, context packet, Current State, correction/outbox, provenance,
  generation, recovery, and conformance modules;
- the `framework-admission` Skill and public test Runner;
- exact-host compatibility evidence and synthetic verification assets.

OpenClaw still owns sessions, the Agent loop, native memory tools, and its native
audit trajectory. Stella Runtime is not a second Agent loop, general memory
system, vector database, persona engine, or action authority.

## Install

Requirements:

- Node.js `24.18.0` exactly;
- OpenClaw extended-stable `2026.6.34` exactly.

After `0.2.0` is published, install the exact stable version through OpenClaw:

```sh
openclaw plugins install @tower1229/stella-cognitive-runtime@0.2.0
openclaw plugins inspect cognitive-runtime --runtime --json
openclaw cognitive self-check
```

Library or Runner consumers can install the exact package with:

```sh
npm install --save-exact @tower1229/stella-cognitive-runtime@0.2.0
```

Begin in `off`, configure the Instance Runtime Config and Git-external Runtime
and Generation storage, then pass exact-host conformance before moving through
`observe` to `enforce`. Active Run Bindings are compiled from the active Pointer,
Activation Receipt, immutable Generation, and State View rather than inline
configuration. See the [operations guide](docs/OPERATIONS.md).

## Configuration reference

The machine-readable configuration authority is `openclaw.plugin.json`; unknown
properties are rejected. The human reference covers:

- `off`, `observe`, and `enforce` semantics;
- active Run capacity and drain/cleanup limits;
- instance/storage identity, eligible Host scope, and binding proof locations;
- recovery root, active instance, and allowed instance revisions;
- every `openclaw cognitive` CLI command.

Read [Configuration reference](docs/CONFIGURATION.md).

## Data and authority

This repository and npm package contain generic Runtime code and synthetic data
only. A separate private Authority Repository owns durable knowledge, identity,
configuration, and migration intent. Git-external Runtime State owns Current
State, unfinished corrections/outbox, protected Candidate admission and
Approval Receipt records, minimized overlays, and rebuildable projections.

Private data, credentials, live databases, Recovery Snapshots, conversations,
real experience records, and Instance Test Packs must not enter this repository,
CI artifacts, or the npm tarball. Read [Data boundaries](docs/DATA-BOUNDARIES.md).

## CLI

The main operational surface is `openclaw cognitive`:

- read-only `validate`, non-activating `build`, full-barrier `sync`, and `generation show`;
- `self-check`, `metrics`;
- `state`, `trace get|query`;
- `backup`, read-only `verify`, and rollback-safe `restore`.

Structured operational commands require `--json` where offered. Run
`openclaw cognitive <command> --help` or read the
[Configuration reference](docs/CONFIGURATION.md) for exact options.

The package also exposes `stella-runtime-test` for repository-owned tests and an
optional external Instance Test Pack. Private packs execute locally and are not
copied or uploaded by the Runner.

## Development and verification

```sh
npm ci
npm run typecheck
npm test
npm run test:pack-install
```

`npm test` builds generated JavaScript and runs unit, contract, integration, and
pack-install tests. Pack-install creates a real tarball, audits its allowlist and
public content, installs it into an isolated OpenClaw environment, checks
Plugin/CLI/Skill discovery and typed-hook behavior, rehearses successor and
recovery failure paths, restarts the Gateway, uninstalls, and proves config
restoration. Fixtures are synthetic.

## Source of truth

- [Domain language](CONTEXT.md)
- [V1 requirements](docs/requirements/V1.md)
- [V1 architecture](docs/architecture/V1.md)
- [Data contracts](docs/architecture/DATA-CONTRACTS.md)
- [Requirement provenance](docs/REQUIREMENT-PROVENANCE.md)
- [Implementation roadmap](docs/roadmap/V1.md)
- [OpenClaw compatibility evidence](docs/evidence/openclaw-2026.6.34.md)
- [Runtime recovery ADR](docs/adr/0001-runtime-owns-state-recovery.md)
- [Repository authority ADR](docs/adr/0002-runtime-repository-is-requirement-authority.md)
- [Changelog](CHANGELOG.md)

This repository is the complete authority for generic Runtime requirements,
architecture, decisions, evidence, implementation, build, test, and release. A
consumer repository is optional and never an implementation dependency.

## Upgrade, rollback, and recovery

For the `0.2.0` stable line, the exact package rollback version is the published
`0.1.0`. Use exact package versions and integrity, retain that verified artifact
and receipt, create and read-only verify a Runtime Recovery Snapshot, then prove
State/outbox and restart continuity before enabling `observe` or `enforce`.
Package rollback and state recovery are separate operations. The full sequence is
in [Operations](docs/OPERATIONS.md).

## Known limitations

V1 has one exact OpenClaw matrix row. It does not support `runContext`, native
structured output, direct persisted-session embedded Runs, host next-turn
injection, or bundled-only scheduling. Successor attempts are at-least-once with
one successful completion, not cross-Run exactly-once delivery. Cloud disaster
recovery, bare-metal imaging, generic migration, complete erasure, and retention
automation are outside V1.

Consumer product acceptance and personal usefulness are downstream non-blocking
evidence; they are not generic Runtime technical release gates. Read the full
[support policy and known limitations](docs/SUPPORT.md).
