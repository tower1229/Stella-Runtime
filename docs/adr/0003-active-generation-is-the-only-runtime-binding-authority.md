---
status: accepted
---

# Active Generation is the only Runtime binding authority

Stella Runtime resolves each eligible new Run's binding from the Active
Generation and its immutable State View exactly once when that Run begins. In
`enforce`, resolution failure stops the private cognitive Run instead of falling
back to an older Generation or an ungoverned native answer. The target release
removes the static inline `runtime.binding` configuration because two binding
sources would permit configuration drift and make generation activation weaker
than Runtime consumption; no compatibility path is required because the prior
release was never activated by a real Private Instance.

Before the first successful `sync`, `off` bypasses Binding resolution and
`observe` may validate and trace without injecting cognitive content. `enforce`
never fabricates an empty Generation or falls back to a native answer when an
Active Generation and its valid Activation Receipt are unavailable.
