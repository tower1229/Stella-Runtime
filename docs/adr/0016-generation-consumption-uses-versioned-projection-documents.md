---
status: accepted
---

# Generation Consumption uses versioned Projection Documents

Each Generation owns an immutable retrieval directory with one deterministic
Projection Document per layer, stable ID, and version; `extraPaths` points to
that directory directly rather than a mutable directory or symlink. Document
paths and headers redundantly bind Generation, authority identity, role,
checksum, and sources so OpenClaw `memory_search` paths and `memory_get` content
can be cross-checked. Runtime records which `extraPaths` entries it owns and
replaces only those Runtime-managed Retrieval Paths, preserving every unrelated
instance path. An identical valid target with a valid Activation Receipt makes
`sync` a no-op, while `--force` rebuilds and reverifies the same identity without
minting another Generation.
