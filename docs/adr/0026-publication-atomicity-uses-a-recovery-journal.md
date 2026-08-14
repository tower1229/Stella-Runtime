---
status: accepted
---

# Publication atomicity uses a recovery journal

Authority Git commit and Approval Receipt consumption form a recoverable logical
transaction through a minimal durable Publication Journal. One Receipt creates
one immutable Change Set and one commit containing non-sensitive trace
identifiers, and exact retries either
recognize and finalize that commit or fail closed. The design does not claim a
cross-store ACID transaction and does not introduce a general Candidate workflow
state machine.
