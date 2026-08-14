---
status: accepted
---

# The first release uses a local trust boundary

Version 0.2.0 targets one private user on one controlled host. A configured
Telegram provider identity is the Authority Owner for channel confirmation, and
access to the local Runtime and Authority operational environment is sufficient
for CLI operation. Checksums, host-scoped Message References, base-version CAS,
atomic Receipt consumption, and filesystem permissions prevent accidental or
LLM-mediated authority changes; digital signatures, key rotation, delegated
identity, multi-tenant authorization, cross-trust-domain Receipts, and third-party
offline verification are explicitly outside this release.
