---
status: accepted
---

# Approved authority publishes before automatic sync

An accepted or finally rewritten Candidate Revision passes Admission and is
sealed into one immutable Change Set without a second content approval. The
Change Set is immediately sent to the consumer Authority Publishing Service.
Durable atomic publication consumes the Approval Receipt and then
uses the consumer's Git Adapter in a dedicated clean Authority Checkout to
create a local commit and exact Source Revision. Runtime neither owns this
checkout nor pushes it; remote push policy remains instance-owned. Publication
then invokes the same idempotent `sync` operation. If `sync` fails, the immutable
Authority Version remains Pending Activation, the prior Generation continues to
serve, and repair retries without deleting or overwriting confirmed authority.

Change Set publication and synchronization are serialized. Every committed Authority
Version remains auditable, but pending work may coalesce to the latest complete
Source Revision; intermediate revisions need not each become an Active
Generation. This is reported as a Synchronization Gap, with any crossed revision
linked to the later target rather than modeled as a separate lifecycle state.

The Approval Message Reference receives deterministic status updates for
accepted, durably published, and activated. A sync failure reports that Authority
is published but not active, identifies the retry target, and states that the
prior Generation continues serving. Runtime never asks an LLM to explain this
transition.

Remote push is not a Runtime activation invariant. A Private Instance may apply
an instance policy such as `push_before_sync`; Runtime consumes only the selected
confirmed local Source Revision and neither chooses a remote nor forces a push.
CangHai's Instance Cutover Plan makes `push_before_sync` mandatory.
