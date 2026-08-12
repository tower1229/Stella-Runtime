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

The V1 previous verified rollback record is `0.1.0-beta.0` at source revision
`1260ba888ea84e0a0d0da0f72c6c9c0db532d323`. Pack-install builds that fixed
source revision as an exact beta tarball, installs it, upgrades to `0.1.0`, and
checks the installed package and lockfile integrity. This is a verified source
rollback artifact; until bootstrap publication succeeds it is not a registry
locator. The first stable release has no earlier stable npm version.

## Release operator checklist

- For the first registry publication only: `npm view
  @tower1229/stella-cognitive-runtime version` currently returning `E404` means
  trusted publishing cannot yet be configured. From the exact verified
  `0.1.0-beta.0` commit, an authenticated maintainer must bootstrap the public
  scoped package with interactive 2FA, then verify its registry integrity. Do
  not bootstrap `0.1.0` directly.
- After the package exists, bind the npm trusted publisher to organization
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
