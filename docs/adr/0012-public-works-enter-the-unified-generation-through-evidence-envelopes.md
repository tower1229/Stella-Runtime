---
status: superseded by ADR-0030
---

# Public works enter the unified Generation through Evidence Envelopes

Canonical public works remain in the consumer repository, whose adapter emits
checksummed Evidence Envelopes into the unified Authority input without copying
article bodies or exposing consumer directory semantics to Runtime. A bounded
Content Resolver returns only registered canonical content whose hash matches
the Envelope, rejects symlinks and path escape, and cannot write authority; the
resolved bytes exist only as build input and derived projection content. The
target `enforce` architecture has no parallel legacy retrieval path. Minimal
Bootstrap Projections use Bootstrap Aliases, and Generation activation rejects
duplicate stable-ID evidence between Bootstrap and ordinary retrieval
projections.

Runtime owns the Evidence Envelope contract and bounded Content Resolver Port.
CangHai owns the mapping of its canonical public articles into Envelopes and the
read-only Resolver implementation. Runtime never scans a consumer directory such
as `20_Publish/articles`, and CangHai does not retain a parallel Composite RAG
path in the target `enforce` architecture.
