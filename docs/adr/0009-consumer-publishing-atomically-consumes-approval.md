---
status: accepted
---

# Consumer publishing atomically consumes approval

The consumer-owned Authority Publishing Service atomically applies the immutable
Change Set derived from one approved Candidate Revision and persists its Approval
Receipt to publication mapping. A Change Set may contain every file operation
required by one complete approved Entity, but may not combine unrelated
Candidates or publish a partial Entity. Runtime owns
the Publishing Port and validation semantics but not the consumer's storage;
this places idempotency at the actual Authority commit and avoids a split where
Runtime consumes approval before a failed private write or a successful write
leaves the same Receipt reusable. Publication compares the approved base
Authority version and checksum before writing and fails closed on concurrent
change. Before publication, an identity authorized by the consumer may record a
durable Receipt Withdrawal through the Publishing Port; withdrawn approval is
deterministically unusable and deleting a Candidate draft is not revocation.

Because Git publication and Runtime Receipt consumption are separate durable
stores, this guarantee is implemented as a recoverable logical transaction, not
as a claimed cross-store ACID transaction. A minimal Publication Journal records
the prepared exact Change Set, Git commit result, and consumption finalization;
recovery recognizes the exact commit and checksum and either finishes that same
publication idempotently or fails closed. Automatic publication creates one
Authority commit per Change Set and Approval Receipt. The commit mapping records
only Change Set ID, Candidate type, stable ID and revision, Authority version,
Candidate checksum, and Approval Receipt ID; private provider identity and chat
content remain outside Git.
