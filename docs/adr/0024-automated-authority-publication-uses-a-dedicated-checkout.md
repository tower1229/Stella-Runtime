---
status: accepted
---

# Automated authority publication uses a dedicated checkout

The consumer Git Adapter performs automated Authority publication in a
dedicated, controlled, clean Authority Checkout. It creates a local commit and
returns the exact Source Revision used by `build`, while leaving remote push
policy to the Private Instance. Runtime never stashes, overwrites, or commits a
user's ordinary development workspace, and `build` refuses dirty or ambiguous
Authority input.
