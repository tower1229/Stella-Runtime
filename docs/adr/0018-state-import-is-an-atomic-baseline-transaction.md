---
status: accepted
---

# State Import is an atomic baseline transaction

Only a trusted operational entry may execute State Import after explicit empty
State Initialization and before the first real Run. Its Manifest binds the empty
Head checksum, ordered normalized Events with legacy source mappings, batch and
idempotency checksums, and expected final Head and View; dry-run validates the
whole batch and one failure prevents every write. When only a legacy snapshot
exists, imported-baseline Events preserve the known current values and state that
prior history is unknown instead of fabricating a timeline.

For the CangHai Stella migration, a historical snapshot, tracking record, diary,
or model inference is not a known current value. Its State Import Manifest must
exclude it unless the exact value is newly user-confirmed or independently
verified at cutover; otherwise the instance starts with an explicitly empty or
partially unknown Current State.
