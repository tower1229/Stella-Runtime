---
status: accepted
---

# Generation identity excludes release time

The deterministic `generation-<full-content-hash>` identity covers the authority
revision, normalized private Authority content, Binding, Contract Set version,
and Builder Format Version. The independent Public Author Corpus does not
contribute to a Generation identity. Package version and
build time remain artifact metadata but do not change identity unless they
change projection semantics, preventing identical target projections from
receiving different identities merely because the package was republished.
