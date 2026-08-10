# Stella Runtime

Stella Runtime is an instance-neutral cognitive runtime for OpenClaw. It provides
versioned contracts, runtime integration, CLI tooling, framework admission, and
verification infrastructure without embedding any user's private data or
instance-specific worldview.

> Status: pre-alpha handoff. The repository identity and architecture boundary
> are frozen; the executable package scaffold has not been implemented yet.

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
  synthetic fixtures, compatibility manifests, and package/release validation.
- A separate authority repository owns each private Agent's knowledge, identity,
  configuration, version pin, migration map, and de-identified instance tests.
- Git-external runtime storage owns Current State events, compiled generations,
  traces, and raw experience records. Derived generations are rebuildable and
  are never a second authority source.

Private data, credentials, live state databases, real conversations, and
instance-specific cognitive content must never enter this repository or its npm
tarball.

## Start here

- [Project background](docs/PROJECT-BACKGROUND.md)
- [Domain language](CONTEXT.md)
- [Implementation issues](https://github.com/tower1229/Stella-Runtime/issues)

The first implementation slice is the buildable single-package scaffold. It
must use synthetic fixtures only and must not connect to a live private Agent.
