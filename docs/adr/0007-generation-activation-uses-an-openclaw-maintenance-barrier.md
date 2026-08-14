---
status: accepted
---

# Generation activation uses an OpenClaw maintenance barrier

For the exact OpenClaw 2026.6.34 adapter, Generation activation rejects new
eligible private Runs and drains existing ones before changing the host retrieval
configuration, rebuilding and verifying its index, and exposing the matching
Active Generation. The Runtime's OpenClaw Adapter owns these host operations
through supported configuration and memory interfaces while Instance Integration
only supplies instance parameters and invokes the Runtime; this maintenance
window is preferred to an unproven online transaction across Plugin state,
OpenClaw configuration, and the memory index. After deep index and retrieval
verification, Runtime writes an Activation Receipt binding the Generation,
projection checksums, host configuration hash, and index evidence, then switches
the Active Generation pointer as the final visible commit. New Runs reject a
binding whose Receipt is missing or invalid. The public operational CLI exposes
this complete barrier as `sync` and does not expose the prior pointer-only
`generation activate` command. A failed attempt restores the prior host retrieval
configuration, force-rebuilds and verifies the prior index and search/get
behavior, and keeps the Barrier closed if that recovery cannot be proven.
The Barrier is represented by a durable Maintenance Gate checked before Binding
resolution. After existing RunScratch entries drain, a durable Sync Journal
tracks host configuration, index, Receipt, and Pointer steps. A crash or Plugin
restart leaves `enforce` blocked until Runtime deterministically completes the
target or restores and verifies the prior state; neither process-local locks nor
manual gate deletion count as recovery.
