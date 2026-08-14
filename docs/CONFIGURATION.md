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
| `routerTimeoutMs` | Maximum host Router completion time. |
| `routerMaxTokens` | Maximum Router output token request. |
| `routerMaxInputCharacters` | Maximum bounded Router input size. |
| `routerMaxOutputCharacters` | Maximum accepted Router output size. |
| `packetMaxCharacters` | Maximum constructed context packet size. |
| `scratchCapacity` | Maximum concurrent Run scratch entries. |
| `scratchTtlMs` | Secondary cleanup TTL for abandoned scratch. |

Limit exhaustion degrades closed. It never changes the pinned generation or
uses `sessionKey` as Run correlation.

## Immutable binding

`runtime.binding` pins `syncGeneration`, `authorityRevision`,
`stateViewVersion`, the optional `activeGoverningSystem`, a checksummed
`registry`, and role-separated context. Registry entries declare an ID, role,
version, generation, and SHA-256 checksum. A governing system is supplied by a
Private Instance; the Runtime contains no built-in worldview.

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
| `openclaw cognitive generation build|verify|activate|rebuild ... --json` | Manage one immutable authority generation. |
| `openclaw cognitive state --instance ID [--revision N] --json` | Read an immutable State View. |
| `openclaw cognitive trace get|query ... --json` | Read minimized cognitive provenance. |
| `openclaw cognitive backup --instance ID --output DIR --json` | Create a new Recovery Snapshot. |
| `openclaw cognitive verify --snapshot DIR --json` | Verify a snapshot read-only. |
| `openclaw cognitive restore --instance ID --snapshot DIR --json` | Restore with required rollback safety. |

Use `openclaw cognitive <command> --help` for the exact options in the installed
package version.
