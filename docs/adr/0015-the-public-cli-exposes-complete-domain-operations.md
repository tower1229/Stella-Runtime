---
status: accepted
---

# The public CLI exposes complete domain operations

Version 0.2.0 exposes `validate`, `build`, `sync`, `generation show`,
`state initialize/import/view/correct`, `trace get/query`, `self-check`,
`metrics`, and Recovery operations. `validate` is read-only and never
normalizes source files; `build` accepts an explicit committed Source Revision
and writes only immutable Generation and Projection artifacts; only `sync` may
enter the Activation Barrier and change OpenClaw configuration, its retrieval
index, the Activation Receipt, and finally the Active Pointer. Pointer mutation
remains an internal final commit of `sync`; the package provides no old aliases
or public partial activation command.

`generation show` is the canonical read-only status view for the Active
Generation and Authority revision, latest Authority revision, Synchronization
Gap, and Activation Receipt validity. `sync` separately reports the result of
the attempted transition.

`validate` checks the selected Authority Source Revision, Instance Runtime
Config, and public contracts without host
mutation. `self-check` owns Runtime storage, Plugin, exact OpenClaw and Node
capability, independent Public Corpus Adapter health, and live instance
environment checks. `sync --revision`
validates its target, reuses an existing valid Generation or builds it when
missing, and then executes the complete Barrier; standalone `build` remains a
useful prebuild operation rather than a prerequisite command sequence.
