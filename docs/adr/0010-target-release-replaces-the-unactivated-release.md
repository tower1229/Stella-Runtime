---
status: accepted
---

# Target release replaces the unactivated release

The published 0.1.0 package was never activated by a real Private Instance, so
version 0.2.0 implements the confirmed Runtime model directly without old
configuration readers, Schema migration, CLI aliases, static Binding fallback,
or parallel projection paths. Every public contract belongs to one `/v2`
Contract Set and the package exports no `/v1` contracts, keeping the new
semantics unambiguous against published artifacts without a v1 reader,
operational migration, or backward-compatibility mechanism.
