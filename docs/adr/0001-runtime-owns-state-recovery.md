---
status: accepted
---

# Runtime owns authoritative state recovery

Stella Runtime exports, verifies, and restores a versioned private snapshot of
its Authoritative Runtime State. A private authority repository may orchestrate
and transport that artifact for cross-host reconstruction, but it must not copy a
live database or depend on Runtime storage internals; rebuildable projections and
credentials remain outside the required snapshot.
