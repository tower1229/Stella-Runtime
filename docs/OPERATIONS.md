# Operations guide

This guide operates exact artifacts. Replace no version or integrity value with
a range, tag such as `latest`, or floating branch.

## Install 0.1.0

1. Confirm Node.js satisfies `^22.19.0 || ^24.0.0` and OpenClaw reports exactly
   `2026.6.34 (5c38f99)`.
2. Install the exact public package:

   ```sh
   openclaw plugins install @tower1229/stella-cognitive-runtime@0.1.0
   ```

3. Configure `runtime.mode` as `off`, the bounded limits, immutable binding,
   and Git-external recovery root described in `CONFIGURATION.md`.
4. Run `openclaw plugins inspect cognitive-runtime --runtime --json` and
   `openclaw cognitive self-check`.
5. Run conformance, then rehearse `off -> observe -> enforce`; do not enable
   `enforce` when any exact-host capability or continuity check fails.

For a plain npm consumer, use
`npm install --save-exact @tower1229/stella-cognitive-runtime@0.1.0`.

## Upgrade

Before changing a package, create and verify a Runtime Recovery Snapshot, retain
the exact previous tarball/integrity and passing conformance receipt, then install
the new exact version. Verify package identity, Plugin/CLI/Skill discovery,
generation compatibility, State head, pending outbox, and restart continuity in
`off`; repeat in `observe` before enabling `enforce`.

Never infer compatibility from a minimum version. The package version, exact
OpenClaw row, contract versions, and integrity must all match a release pin.

## Generation synchronization

Run synchronization only with the exact Host transition adapter available:

```sh
openclaw cognitive sync --revision COMMITTED_AUTHORITY_SHA --json
```

The command first requires one exact release-channel/OpenClaw/Node row from the
committed Compatibility Matrix; an engine-compatible but unlisted Node version
fails with `INCOMPATIBLE_HOST` before any Host, Receipt, or Pointer mutation.
It may then build a missing deterministic Generation or reuse an existing
verified one. It closes the durable Maintenance Gate before draining Eligible
Runs, applies and verifies the Host configuration, Projection, index, and
search/get sentinels, then writes the Activation Receipt bound to that exact
matrix row and switches the Active
Pointer last. Do not delete `maintenance-gate.json` or `sync-journal.json`
manually after interruption; the next `sync` must first restore and verify the
recorded prior Host state, or keep the Gate closed.
The Plugin performs the same recovery check at startup. Concurrent `sync`
invocations serialize on the Runtime-owned lease rather than interleaving Host
transitions.

Use `openclaw cognitive generation show --json` for the current Active/latest
Source Revisions, Synchronization Gap, Pending Activation, Generation and
Receipt identities, and Receipt validity. `self-check` is read-only and reports
Authority input validation separately from Runtime storage, Plugin, exact
Host/Node, config identity, retrieval, and Public Corpus environment health.
Startup, successful sync, five-minute periodic reconciliation, and detected
drift run complete retrieval verification and persist only bounded health
reason codes. Ordinary Eligible Runs read that receipt plus their existing
Pointer/Receipt/Manifest/Host/config proof; `enforce` rejects drift while
`observe` records it without injecting cognitive content.
`openclaw cognitive metrics --json` reports the corresponding bounded counters;
`openclaw cognitive trace lifecycle --json` reports the recent outcome sequence.

For an instance cutover, pass the exact plan owned by that consumer:

```sh
openclaw cognitive sync \
  --revision COMMITTED_AND_PUSHED_AUTHORITY_SHA \
  --cutover-plan INSTANCE_CUTOVER_PLAN.json \
  --json
```

Do not use this option unless the Plugin integration supplies the declared
publication, instance-cutover, and independent Public Corpus indexing/acceptance
ports. The public
de-identified CangHai fixture requires remote-base verification, successful
push of the target Source Revision, removal of private `30_RAG`, disablement of
`active-memory`, deployment of both target-Generation Bootstrap files, and
preservation of the independent Public Author Corpus. All Host changes occur
while the Maintenance Gate is closed. Public Corpus health/recall must pass
before and after the transition; post-cutover evidence must report no legacy
private hits and no old/new private retrieval coexistence. A failure restores
and verifies the captured prior Host state or leaves the Gate closed.

Keep the configured OpenClaw Gateway reachable during sync: the adapter uses
the supported runtime config mutation interface, forces the configured Agent's
memory index, reads deep status and search through the memory CLI, and invokes
`memory_get` through `gateway call tools.invoke`. It never writes OpenClaw's
index database directly. Do not edit `retrieval-paths.json`; it is the durable
ownership record that lets interrupted activation remove only this instance's
half-applied retrieval path while preserving unrelated paths.

## Recovery

Create a snapshot and verify it before transport:

```sh
openclaw cognitive backup --instance INSTANCE --output SNAPSHOT --json
openclaw cognitive verify --snapshot SNAPSHOT --json
```

Stop admission of new Runs on the target. Restore only to the configured instance
that has not served a new Run, then verify the report before re-enabling traffic:

```sh
openclaw cognitive restore --instance INSTANCE --snapshot SNAPSHOT --json
```

Restore is internally migrated and rollback-safe. Do not copy live databases.

## Rollback

Set mode to `off`, retain the failed artifact and diagnostics, then install the
previous exact verified artifact. Restore a Recovery Snapshot only when state
compatibility or integrity requires it; package rollback and data recovery are
separate operations. Re-run self-check, exact-host conformance, and restart
continuity before moving to `observe`.

The V1 previous verified rollback record is
`@tower1229/stella-cognitive-runtime@0.1.0-beta.0` at source revision
`1260ba888ea84e0a0d0da0f72c6c9c0db532d323`, published under the `beta` dist-tag
with integrity
`sha512-kU+wNjr2fbs+1pIGJEksWTPCe9lOPCsorlaZJayh8wLkzhf0kD8k3GVH6Qb+hRYrq/RlCUe3doSSgEHkNeK1SA==`.
Pack-install builds that fixed source revision as an exact beta tarball, installs
it, upgrades to `0.1.0`, and checks the installed package and lockfile integrity.
The first stable release has no earlier stable npm version.

## Release operator checklist

- The public scoped package was bootstrapped with the exact verified
  `0.1.0-beta.0` artifact. Registry version, `beta` dist-tag, integrity, public
  access, clean install, signature audit, and zero-vulnerability audit passed.
- Stable `0.1.0` was published from source revision
  `513728dc729d3fa66555ecaac10da2bb5f5e4ef3` with registry integrity
  `sha512-I3hRyGfmfR1ZCTlROA+R3nZ3PlNXxrfTXap/sQ5HCM0bMrW7wCZRz+JNaYjXaZUuod3+r/ngKxwI227eViwGdQ==`.
  Clean install, eight registry signatures, provenance attestation, and the
  zero-vulnerability audit passed. GitHub Release `v0.1.0` carries the same
  exact tarball.
- Bind the npm trusted publisher to organization
  `tower1229`, repository `Stella-Runtime`, workflow `release-stable.yml`, and
  environment `npm`. With npm CLI 11.5.1 or later the equivalent authenticated
  command is `npm trust github @tower1229/stella-cognitive-runtime --file
  release-stable.yml --repo tower1229/Stella-Runtime --env npm --allow-publish`.
  Then disallow legacy publish tokens. This bootstrap is a one-time external
  operation, not a CI fallback path.
- all tests and clean pack-install gates pass on the release commit;
- package, lockfile, Plugin manifest, Skill, and compatibility matrix say
  `0.1.0`;
- tag `v0.1.0` points at that exact commit;
- npm trusted publisher is restricted to `release-stable.yml` and environment
  `npm`, with no long-lived publish token;
- workflow-published integrity equals the registry integrity;
- npm signature audit, GitHub attestation, and GitHub Release all succeed.

Consumer product acceptance remains downstream and does not block the generic
Runtime technical release.
