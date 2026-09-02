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

The public `stella.personal-data-locator/v1` resolves one Personal Data
Repository, its `<repository>/stella/` root, and the Authority logical root
`stella/authority`. Read-only Authority validation and Generation builds accept
that subtree as well as the legacy dedicated Authority Repository layout. Git
tree and blob reads are scoped to the Authority prefix and strip it before v2
entrypoint parsing. Dirty or untracked `stella/fitness/` content and ignored
`stella/projections/` therefore do not block a read-only build. Runtime does not
scan or interpret Fitness canonical content; Fitness data may cross into Runtime
only through the versioned projection consumer seam.

At the start of each eligible Run, the Binding Compiler reads
`<runtime_storage>/active-generation.json`, the referenced receipt under
`<runtime_storage>/activation-receipts/`, the immutable Generation under
`<generation_storage>/`, and one checksummed State View. It validates their
Generation, Manifest, Projection, Compatibility Matrix release channel, exact
Host/Node row, instance, and configuration identities once and pins the
resulting Active Run Binding until Run cleanup. Package engine ranges constrain
installation only and never authorize admission.

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

The OpenClaw Generation Consumption Adapter mutates only the configured Agent's
`memorySearch.extraPaths` through the Host runtime config interface. It records
this instance's owned entries in `<runtime_storage>/retrieval-paths.json`,
replaces only those entries on the next sync, and preserves every unrelated
path and every other Agent. The target is the immutable
`<generation_storage>/<generation>/projections/<generation>/` directory.
Activation requires `openclaw memory index --force`, deep memory status, an
identity-bound `memory search` sentinel, and a `memory_get` sentinel invoked
through the Gateway tool interface; an empty, dirty, stale, truncated-before-
identity, or mismatched result fails the Barrier.

An optional `Instance Cutover Plan` turns instance-specific migration policy
into the same `sync` Barrier. Runtime validates the plan schema, canonical
checksum, instance, and target Source Revision before using it. A consumer that
sets `remote_base_check` or `push_before_sync` must provide the corresponding
publication-prerequisite port; these checks are not generic Runtime defaults.
Plans that declare a Public Corpus Adapter must also provide its independent
target-indexing operation and before/after acceptance evidence with a passing
health result, recall checksum, zero legacy private hits, and exactly one private
retrieval Generation: the target. Runtime invokes this consumer-owned indexing
seam inside the Barrier; it is not folded into private Generation indexing.

The OpenClaw instance-cutover port owns consumer-specific mechanism disablement
and deployment destinations for deterministic Bootstrap Projections. During the
closed Barrier, the OpenClaw adapter removes the plan's declared legacy paths,
preserves every declared independent path, invokes that port for mechanisms and
Bootstrap deployment, indexes once, and verifies the complete target before the
Pointer commit. Its captured state participates in ordinary sync rollback and
restart recovery. Bootstrap files identify their Generation, are marked
read-only/non-authoritative, and carry `bootstrap_alias` references to the same
Projection Entries rather than duplicating Evidence.

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

Authority publication remains stricter than read-only validation. The current
publishing port requires its controlled checkout to satisfy its declared clean
checkout policy and receives only exact Authority Change Set operations; it must
not automatically stage or commit `stella/fitness/` or projection data. Until a
separate worktree/index isolates Authority writes inside a Personal Data
Repository, a port that requires the whole repository to be clean must report
that limitation explicitly. This is not complete everyday single-repository
write support.

## CLI reference

All structured operational commands require `--json` where offered.

| Command | Purpose |
| --- | --- |
| `openclaw cognitive self-check` | Read-only Authority-input validation plus Runtime storage, Plugin discovery, exact Host/Node, config identity, index/retrieval, and independent Public Corpus health. |
| `openclaw cognitive metrics --json` | Read bounded Runtime and lifecycle outcome counters without private content. |
| `openclaw cognitive personal-data initialize --json` | Explicitly create or validate the configured fixed Personal Data Repository layout and its Runtime-owned initialization manifest. |
| `openclaw cognitive validate --authority DIR --revision SHA --json` | Read-only validation of one exact clean committed Authority Source Revision. |
| `openclaw cognitive build --authority DIR --state DIR --revision SHA [--bootstrap USER.md,MEMORY.md] --json` | Build or reuse one immutable Generation without activation, optionally deriving Bootstrap projections outside the Generation manifest. |
| `openclaw cognitive sync --revision SHA [--cutover-plan FILE] --json` | Build or reuse the configured committed Authority target, optionally enforce one checksummed Instance Cutover Plan, drain Eligible Runs, prove the Host transition, write its Receipt, and switch the Active Pointer last. |
| `openclaw cognitive generation show --json` | Read Active/latest Source Revisions, Synchronization Gap, Pending Activation, Generation/Receipt identity, and Receipt validity. |
| `openclaw cognitive generation show --state DIR --generation ID --json` | Read one explicit built Generation without implying that it is active. |
| `openclaw cognitive state initialize --instance ID --json` | Explicitly create a valid empty Current State Head. |
| `openclaw cognitive state import --instance ID --manifest FILE --authorization FILE --json` | Validate fresh external authorization for each exact Event, then atomically import one checksummed baseline before the first real Run. |
| `openclaw cognitive state view --instance ID [--revision N] --json` | Read an immutable, checksummed State View. |
| `openclaw cognitive state correct plan --instance ID --preview ID --event FILE --expires INSTANT --json` | Render an exact Correction Preview and checksum. |
| `openclaw cognitive state correct apply --instance ID --preview FILE --checksum SHA256 --correction ID --session SHA256 --prior-run ID --idempotency-key KEY --json` | Apply an unchanged Preview and atomically create its successor outbox. |
| `openclaw cognitive trace get|query ... --json` | Read minimized cognitive provenance. |
| `openclaw cognitive trace lifecycle --json` | Read the bounded accepted/published/pending/activated/rollback/gated outcome trace without private content. |
| `openclaw cognitive backup --instance ID --output DIR --json` | Create a new Recovery Snapshot. |
| `openclaw cognitive verify --snapshot DIR --json` | Verify a snapshot read-only. |
| `openclaw cognitive restore --instance ID --snapshot DIR --json` | Restore with required rollback safety. |

Use `openclaw cognitive <command> --help` for the exact options in the installed
package version.
