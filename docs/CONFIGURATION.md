# Configuration reference

Stella Runtime is configured as the OpenClaw Plugin `cognitive-runtime`. The
Plugin manifest is the machine-readable authority for the accepted shape; it
rejects unknown properties.

## Runtime mode

`runtime.mode` is one of:

- `off`: the Runtime does not execute or inject cognitive context;
- `observe`: the Runtime executes and records bounded results but does not
  inject private cognitive context;
- `enforce`: the Runtime executes and may inject the validated context packet.

Start at `off`, move to `observe` after self-check, and move to `enforce` only
after exact-host conformance passes. A mode change does not replace package or
Recovery Snapshot rollback.

## Runtime limits

All limit values are positive integers:

| Property | Meaning |
| --- | --- |
| `max_active_runs` | Maximum concurrent eligible Run scratch entries. |
| `drain_timeout_ms` | Cleanup TTL for abandoned scratch and the later sync drain bound. |

Limit exhaustion degrades closed. It never changes the pinned generation or
uses `sessionKey` as Run correlation.

## Instance and binding locations

`runtime` is an `Instance Runtime Config` and contains only the instance ID,
operating mode, Runtime and Generation storage locations, Host Agent and eligible
scope, Authority Owner tuple, limits, and adapter locators. It must not contain
an inline Registry, Context, or cognitive Binding.

At the start of each eligible Run, the Binding Compiler reads
`<runtime_storage>/active-generation.json`, the referenced receipt under
`<runtime_storage>/activation-receipts/`, the immutable Generation under
`<generation_storage>/`, and one checksummed State View. It validates their
Generation, Manifest, Projection, Host, Node, instance, and configuration
identities once and pins the resulting Active Run Binding until Run cleanup.

`sync` closes `<runtime_storage>/maintenance-gate.json` before draining existing
eligible Runs. Every Host transition phase is persisted in
`<runtime_storage>/sync-journal.json`; a restart must recover and verify the
recorded prior Host state and Pointer before another target can begin. The Gate
is removed only after matching Projection, configuration, index search/get
evidence, Activation Receipt, and the final atomic Active Pointer commit.
Concurrent operators are serialized by a protected Runtime-storage lease. On
Plugin startup, an unfinished Journal is recovered before admission reopens;
prior recovery must pass the same Pointer, Receipt, Generation, State, exact
Host, configuration, index, and search/get proof required for serving.

Eligible scope is derived from OpenClaw's verified Agent hook fields: the
configured main Agent, a main/direct session key, a user trigger, and matching
provider, sender, and direct-chat identities for the configured Authority Owner.
Router completions, confirmation callbacks, operational probes, index operations,
other actors or Agents, and shared/public chats are bypassed. Missing Host
identity metadata is not treated as private. `enforce` rejects an eligible Run when
binding proof is missing, stale, or inconsistent; `observe` persists validation
trace without injecting private content; `off` does not read binding storage.

## Recovery configuration

`recovery` requires:

- `stateRoot`: Git-external Runtime storage root;
- `activeInstanceId`: the configured Private Instance;
- `instances`: an object keyed by allowed instance ID, each with its current
  `authorityRevision`.

Do not put `stateRoot`, snapshots, credentials, or private authority content in
this repository.

## Candidate confirmation ports

Before admitting Candidates through the OpenClaw singleton, the owning Private
Instance must call `configureOpenClawCandidateAuthorityHead` exactly once with
an Authority Head port keyed by instance, Candidate type, and stable ID. An
unconfigured port fails closed; it is never interpreted as an empty Authority.

Use `createOpenClawTelegramConfirmationPresentation` with the Host runtime and
the exact instance, account, and conversation identities. It sends the complete
Review Artifact through the Telegram outbound adapter and binds the Host send
receipt before any callback can decide the Candidate.

## CLI reference

All structured operational commands require `--json` where offered.

| Command | Purpose |
| --- | --- |
| `openclaw cognitive self-check` | Verify Plugin discovery and host completion availability. |
| `openclaw cognitive metrics --json` | Read bounded Runtime metrics. |
| `openclaw cognitive validate --authority DIR --revision SHA --json` | Read-only validation of one exact clean committed Authority Source Revision. |
| `openclaw cognitive build --authority DIR --state DIR --revision SHA [--bootstrap USER.md,MEMORY.md] --json` | Build or reuse one immutable Generation without activation, optionally deriving Bootstrap projections outside the Generation manifest. |
| `openclaw cognitive sync --revision SHA --json` | Build or reuse the configured committed Authority target, drain Eligible Runs, prove the Host transition, write its Receipt, and switch the Active Pointer last. |
| `openclaw cognitive generation show --state DIR --generation ID --json` | Read a built Generation and its Source Revision without implying that it is active. |
| `openclaw cognitive state initialize --instance ID --json` | Explicitly create a valid empty Current State Head. |
| `openclaw cognitive state import --instance ID --manifest FILE --authorization FILE --json` | Validate fresh external authorization for each exact Event, then atomically import one checksummed baseline before the first real Run. |
| `openclaw cognitive state view --instance ID [--revision N] --json` | Read an immutable, checksummed State View. |
| `openclaw cognitive state correct plan --instance ID --preview ID --event FILE --expires INSTANT --json` | Render an exact Correction Preview and checksum. |
| `openclaw cognitive state correct apply --instance ID --preview FILE --checksum SHA256 --correction ID --session SHA256 --prior-run ID --idempotency-key KEY --json` | Apply an unchanged Preview and atomically create its successor outbox. |
| `openclaw cognitive trace get|query ... --json` | Read minimized cognitive provenance. |
| `openclaw cognitive backup --instance ID --output DIR --json` | Create a new Recovery Snapshot. |
| `openclaw cognitive verify --snapshot DIR --json` | Verify a snapshot read-only. |
| `openclaw cognitive restore --instance ID --snapshot DIR --json` | Restore with required rollback safety. |

Use `openclaw cognitive <command> --help` for the exact options in the installed
package version.
