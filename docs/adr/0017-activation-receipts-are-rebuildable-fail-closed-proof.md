---
status: accepted
---

# Activation Receipts are rebuildable fail-closed proof

An Activation Receipt is rebuildable operational proof rather than personal
authority, but `enforce` refuses a Run when its matching Receipt is absent,
invalid, or known stale. Each Run performs only lightweight Pointer, Receipt,
Manifest, exact-host version, and configuration identity checks; `sync`, startup,
periodic Runtime Reconciliation, and detected drift perform full index status and
search/get verification. Losing a Receipt therefore requires revalidation, not
reconstruction from logs or continued service without proof.
