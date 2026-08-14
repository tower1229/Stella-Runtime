---
status: accepted
---

# Authority admission requires deterministic confirmation

Semantic, Personal Model, and Cognitive Candidate Revisions share an admission protocol
but retain type-specific content and validation rather than a unified persistent
Candidate state machine. The Runtime defines Confirmation Request, Decision
Receipt, and single-use validation contracts; its host adapter captures an
Authority Owner's explicit button, approval-card, or command decision without
LLM interpretation, while the consumer publishing service owns Candidate drafts
and writes private authority. Accepted and finally rewritten decisions produce
Approval Receipts, rejection produces a non-publishing Decision Receipt, and a
rewrite request is only feedback: a newly rendered checksum must be confirmed
again. Exact publication failures may retry idempotently, but durable persistence
of the approved Authority version consumes the Receipt; Generation activation
then retries from committed authority without reusing approval. The Admission
Service remains separate from type-specific content validators such as
`admitFramework()` and from the consumer publishing operation. The consumer
defines its Authority Owner policy, while Runtime verifies that a trusted
Confirmation Gateway issued the Receipt and bound it to a host-scoped Approval
Message Reference, stable Candidate ID and revision, the target Authority
identity and versions, and exact Candidate and diff checksums. The Message
Reference locates the presentation but never replaces Candidate identity.
Requests and unconsumed Receipts inherit their Discovery Authorization boundary;
ending that workflow or invocation invalidates every unresolved Request created
under it. Within a live authorization they have no independent TTL. Checksum
changes invalidate them, explicit withdrawal revokes them,
and committed Authority is corrected only by a newly confirmed later immutable
version. The Authority Owner must be able to inspect the complete immutable
Candidate and exact diff from the bound base version; a changed base rejects the
publication and requires a newly rendered Candidate and confirmation. Rejection
ends only that exact Candidate, so later proposals for the same stable Authority
identity use a new Approval Message Reference and confirmation. The target
release provides type-specific Semantic, Personal Model, and Cognitive
validators behind the same Admission Service; none may bypass confirmation. For
the single-user local deployment, Runtime trusts the configured provider actor
context supplied by the Confirmed Channel and the consumer's local publication
boundary. Receipts are protected by exact content binding, base comparison,
local atomic consumption, and filesystem permissions rather than a signature
key or independent identity system.
