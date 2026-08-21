# Support policy and known limitations

## Supported matrix

`0.2.1` is the published stable release. It supports only
OpenClaw release channel `extended-stable`, exact version `2026.6.34`, with
Node.js `24.18.0`, and has passed packed Generation Consumption acceptance for
that exact combination. Published `0.2.0` is the verified rollback version. The
committed compatibility manifest and
synthetic host smoke evidence are normative. No version range, later version, or
rolling documentation implies support.

The package `engines` value `^22.19.0 || ^24.0.0` is a package-install boundary,
not a compatibility or support declaration. This release admits only
the exact Node.js version in the Compatibility Matrix. The public contracts
under `cognitive-runtime.<contract>/v2` remain compatible unless a versioned
migration and rejection behavior are published.

Security, correctness, privacy-boundary, recovery, and exact-host compatibility
bugs are supported for the `0.2.x` line. New host versions require a new matrix row,
package install, runtime inspection, behavioral smoke, and failure-path evidence.

## Known limitations

- The Runtime is not a general memory system, second Agent loop, persona engine,
  vector database, action authority, or governance UI.
- Only the five verified typed hooks, including the fail-closed
  `before_agent_run` gate, and host-owned `llm.complete` path are
  supported. `runContext`, native structured output, direct persisted-session
  embedded Runs, host next-turn injection, and bundled-only scheduling are not.
- Successor delivery is at-least-once across attempts and exactly once for a
  successful completion; it does not claim cross-Run exactly-once delivery.
- A configured governing system comes from a Private Instance. No worldview or
  personal model is built into the package.
- Consumer product acceptance, personal usefulness, and real-life experience
  records are downstream non-blocking matters and never public release fixtures.
- The Runtime does not provide cloud disaster recovery, bare-metal imaging,
  generic migration, complete erasure workflows, or automatic retention policy.

## Reporting

Use the repository issue tracker for reproducible public defects without private
content. Do not attach credentials, authority documents, live databases,
Recovery Snapshots, conversations, or Instance Test Packs. For a compatibility
report, include the exact package integrity, Node.js version, OpenClaw version
and build, deployment mode, bounded reason code, and synthetic reproduction.
