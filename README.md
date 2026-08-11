# Stella Runtime

Stella Runtime is an instance-neutral cognitive runtime for OpenClaw. It provides
versioned contracts, runtime integration, CLI tooling, framework admission, and
verification infrastructure without embedding any user's private data or
instance-specific worldview.

> Status: pre-alpha. The repository identity, architecture boundary, V1
> requirements, implementation roadmap, and executable single-package scaffold
> are in place; business modules remain contract-only or unimplemented.

## Identity

| Surface | Frozen value |
| --- | --- |
| Project | Stella Runtime |
| Repository | `tower1229/Stella-Runtime` |
| npm package | `@tower1229/stella-cognitive-runtime` |
| OpenClaw Plugin ID | `cognitive-runtime` |
| Schema namespace | `cognitive-runtime.<contract>/v1` |
| License | MIT |
| Node.js | `^22.19.0 || ^24.0.0` |
| Initial OpenClaw host | extended-stable `2026.6.34` |

The Stella name is the project and distribution brand. Public protocol identity
uses `cognitive-runtime.*`; it must not encode a specific private Agent or user.

## Repository boundary

- This repository owns generic Runtime source, contracts, CLI, Plugin Skill,
  synthetic fixtures, compatibility manifests, authoritative Runtime recovery
  contracts, and package/release validation.
- A separate authority repository owns each private Agent's knowledge, identity,
  configuration, version pin, migration map, and de-identified instance tests.
- Git-external runtime storage owns Current State events, compiled generations,
  traces, and raw experience records. Derived generations are rebuildable and
  are never a second authority source.

The Runtime must export, verify, and restore its authoritative Git-external state
through a versioned private recovery snapshot. The private migration orchestrator
stores and transports that snapshot; it never reads Runtime database internals.

Private data, credentials, live state databases, real conversations, and
instance-specific cognitive content must never enter this repository or its npm
tarball.

## Start here

- [Project background](docs/PROJECT-BACKGROUND.md)
- [Domain language](CONTEXT.md)
- [V1 requirements](docs/requirements/V1.md)
- [V1 architecture](docs/architecture/V1.md)
- [V1 data contracts](docs/architecture/DATA-CONTRACTS.md)
- [Requirement provenance and migrated decision basis](docs/REQUIREMENT-PROVENANCE.md)
- [V1 implementation roadmap](docs/roadmap/V1.md)
- [OpenClaw 2026.6.34 host evidence](docs/evidence/openclaw-2026.6.34.md)
- [Runtime recovery ownership decision](docs/adr/0001-runtime-owns-state-recovery.md)
- [Repository requirement authority decision](docs/adr/0002-runtime-repository-is-requirement-authority.md)
- [Implementation issues](https://github.com/tower1229/Stella-Runtime/issues)

The first implementation slice is the buildable single-package scaffold. It
must use synthetic fixtures only and must not connect to a live private Agent.

All generic Runtime development decisions and implementation requirements are
owned here. A consumer repository may supply a private Instance Test Pack or
orchestrate recovery, but Runtime contributors never need that repository to
understand, implement, test, package, or release the Runtime.
