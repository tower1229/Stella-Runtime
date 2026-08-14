---
status: accepted
---

# Evidence v2 preserves media and time precision

Evidence v2 directly models media entries with `id`, `path`, `role`,
`importance`, `caption`, optional `salient`, and a required `visual_thesis` for
high-importance evidence. Temporal Values use `{ value, precision }`, validate
`YYYY`, `YYYY-MM`, `YYYY-MM-DD`, or RFC 3339 for `year`, `month`, `day`, or
`instant`, and avoid discarding media or inventing missing precision. Consumer
data preparation emits a canonical `source.md`, preserves an unchanged legacy
Markdown source under `original/legacy.md`, and places attachments under
`assets/`; Runtime reads only the target Source Package and contains no legacy
parser or v1 migration.

Runtime owns the strict v2 Schema and validator. A consumer-specific Evidence
Migration Adapter, such as CangHai's, owns legacy field mapping, canonical
`source.md` creation, unchanged `original/legacy.md` preservation, and asset
migration; no consumer legacy rule enters the public Builder.
