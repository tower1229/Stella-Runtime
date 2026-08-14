---
status: accepted
---

# Authority layout and eligible Run scope are fixed

Runtime reads only `evidence/**/source.md`, `semantic/**/claim.md`,
`cognitive/**/entity.md`, and root `cognitive-binding.json`; consumer globs and
arbitrary Markdown discovery are not protocol. Personal Model remains a Semantic
`claim.md` with `record_type: personal_model` and stronger type-specific
validation. Runtime executes only for the Instance Runtime Config's private main
Agent and session scope, excluding Router completions, Confirmation callbacks,
maintenance and index probes, and public or shared Agents. That config contains
only mode, limits, instance and storage locations, OpenClaw agent identity,
eligible scope, and the configured Telegram Authority Owner tuple, never an
inline Registry, Context, or cognitive Binding.
