# Stella Runtime Context

Stella Runtime is a public, instance-neutral cognitive runtime. This glossary
keeps the public engine, a private Agent instance, its authority repository, and
its live runtime state from being conflated.

## Language

**Cognitive Runtime**:
The generic engine that validates cognitive contracts, selects relevant context,
and integrates that context with a host Agent loop. It owns no durable personal
truth.
_Avoid_: Stella instance, personal knowledge base, Agent persona

**Runtime Package**:
The single versioned distribution containing the Plugin runtime, CLI, public
contracts, framework-admission Skill, and required self-check assets.
_Avoid_: runtime bundle, CLI package, Skill package

**Cognitive Contract**:
An instance-neutral, versioned schema in the `cognitive-runtime.<contract>/v1`
namespace that defines inputs, outputs, identity, authority, or trace semantics.
_Avoid_: Stella schema, private data format

**Private Instance**:
A deployment of the Cognitive Runtime bound to one private Agent's configuration,
authority data, session boundary, and version pin.
_Avoid_: tenant, built-in Stella behavior, public fixture

**Authority Repository**:
An external, private repository that is the auditable source for an instance's
durable knowledge, identity, cognitive definitions, configuration, and migration
records.
_Avoid_: Runtime repository, live state directory, generated index

**Runtime State**:
Private, Git-external data owned by one Private Instance, including authoritative
Current State and rebuildable operational projections. It is not source code and
is recovered through a Runtime Recovery Snapshot rather than ordinary Git files.
_Avoid_: authority repository, repository backup, source of truth

**Authoritative Runtime State**:
The minimal Git-external state whose loss would change the instance's current
meaning or leave a committed correction unfinished. It excludes projections that
can be rebuilt from the Authority Repository.
_Avoid_: all runtime files, cache, generated index

**Runtime Recovery Snapshot**:
A private, versioned, checksummed artifact exported and restored by the Runtime
to preserve Authoritative Runtime State across hosts without exposing its storage
implementation to the migration orchestrator.
_Avoid_: database copy, generation archive, authority repository

**Active Generation**:
The immutable, checksummed projection of one authority revision that is visible
to new Runs as a single `sync_generation`.
_Avoid_: mutable knowledge cache, second authority source

**Compatibility Matrix Row**:
The support claim for one release channel and one exact OpenClaw version, backed
by package installation and capability smoke evidence.
_Avoid_: minimum supported version, version greater than or equal to

**Capability Smoke**:
A real-host verification that an exact OpenClaw version exposes the fields,
ordering, and behavior required by one compatibility matrix row.
_Avoid_: type-check only, rolling documentation assumption

**Instance Test Pack**:
A private or de-identified set of instance configuration, fixtures, and
assertions consumed by the public Runner without copying the Runner itself.
_Avoid_: public personal data, forked test framework

**Experience Record**:
A private record of a real user's prompt, trace, correction, and usefulness
judgment. It remains Git-external and is never a public Golden fixture.
_Avoid_: synthetic Golden, telemetry sample, public evaluation corpus
