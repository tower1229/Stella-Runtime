---
status: accepted
---

# Candidate discovery is bounded and publication uses Change Sets

Candidate generation requires a user-granted Discovery Authorization scoped to
one workflow or invocation; ending it invalidates every unresolved Request and
does not create a persistent Candidate lifecycle. Each proposal has a stable
Candidate ID and immutable revision, while the Approval Message Reference only
locates its presentation. Acceptance seals that exact revision and diff into one
immutable, idempotent Change Set containing all operations needed to atomically
publish the approved unit.
