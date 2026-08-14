---
status: accepted
---

# Current State is bound, not indexed

Current State never enters the Host Retrieval Projection. Each Run derives one
immutable State View from the State Store and the Binding Compiler injects its
minimal content into the Context Packet, preventing stale search results and a
second state authority. Instance Runtime Config contains only mode, limits,
instance ID, Runtime and Generation roots, OpenClaw agent ID, and an Authority
Owner policy reference; it contains no inline Registry, Context, or cognitive
Binding content.

An atomic State Correction makes its new immutable State View available to the
next Eligible Run without a Generation build, host index rebuild, or `sync`.
