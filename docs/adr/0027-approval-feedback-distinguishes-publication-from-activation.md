---
status: accepted
---

# Approval feedback distinguishes publication from activation

The confirmed channel deterministically reports Candidate acceptance, durable
Authority publication, and successful activation as separate outcomes. When
`sync` fails, it reports the exact pending target and that the prior Generation
continues serving. These updates are attached to the Approval Message Reference
and never depend on LLM interpretation.
