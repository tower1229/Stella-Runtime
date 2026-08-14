---
status: accepted
---

# Sync may coalesce committed authority revisions

Authority publication preserves every confirmed version and commit, while
automatic synchronization is serialized and may target the latest complete
Source Revision instead of activating every intermediate revision. Crossed
revisions remain linked in publication history but do not acquire a persistent
workflow state machine. The prior Generation serves until the selected target
passes the complete Activation Barrier.
