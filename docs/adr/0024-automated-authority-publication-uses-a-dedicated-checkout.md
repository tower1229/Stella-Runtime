---
status: accepted
---

# Automated authority publication uses a dedicated checkout

The consumer Git Adapter performs automated Authority publication in a
dedicated, controlled Authority Checkout. It creates a local commit containing
only the exact Authority Change Set operations and returns the Source Revision
used by `build`, while leaving remote push policy to the Private Instance. It
must never automatically stage or commit `stella/fitness/` or projection data.

Read-only validation and Generation builds may scope cleanliness to the
`stella/authority/` logical root in a Personal Data Repository. Publication is
deliberately stricter: until the adapter uses a separate worktree/index for the
Authority subtree, an implementation may require the whole controlled checkout
to be clean and must report that limitation explicitly. This is not complete
everyday single-repository write support. Runtime never stashes, overwrites, or
commits a user's ordinary development workspace.
