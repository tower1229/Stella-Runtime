# OpenClaw extended-stable 2026.6.34 host evidence

> Status: accepted first-host baseline
> Exact build observed: `2026.6.34 (5c38f99)`
> Published stable release: `0.2.1` on Node.js `24.18.0`
> Previous rollback version: published `0.2.0`

## Unreleased Issue #34 source acceptance

On 2026-08-26, local source revision `55b4fd3` plus the working Issue #34 diff
passed the exact-host scenario. This is source verification only: it is not
evidence for an npm package, GitHub Release, or published registry artifact.

The Fitness Generation Consumption acceptance packs Fitness source revision
`ac1b8eaf55cf0cba4f5035b82ff74ac5ddd8cf8e`, publishes F1, activates G1, then
publishes corrected F2 and proves a distinct G2 Receipt, exact Host retrieval,
and next Eligible Run consumption with zero prior-value hits. A subsequent
destructive Fitness replacement with forced index failure keeps the Gate closed
and reaches zero final Agent model requests before an exact retry recovers. The
same acceptance force-upgrades both packed Plugins and preserves the consumer
artifacts; after reinstall and resync, a real Eligible Run consumes the exact F3
projection revision without the replaced F2 revision. OpenClaw `2026.6.34`
removes an uninstalled Plugin's complete config entry; acceptance therefore
preserves canonical Fitness data and the last verified projection, requires
Fitness to reject the missing locator, and restores the same locator explicitly
after Runtime reinstall rather than copying or guessing the path.

The real-Host scenario exercises representative successful and destructive
Fitness replacements. The exhaustive stale, blocked, revoked, checksum,
source-instability, invalid-edit, publication-crash, rollback, and idempotency
matrix remains at the packed public projection contract and integration seams;
it is not repeated as a cross-product of every filesystem fault and Host Run.

## Runtime 0.2.1 fail-closed and registry acceptance

On 2026-08-21, the `0.2.1` source target passed the complete packed exact-host
scenario. A real Gateway CLI Run targeting the exact private-session identity
proved that malformed Router output invokes `before_agent_run`, performs only
the bounded Router completion, and stops before the final Agent model request.
The stable workflow then installs the exact published registry version, binds it
to the workflow tarball integrity, and repeats discovery, Gateway restart,
Generation Consumption, failure recovery, uninstall, and config restoration.

## Runtime 0.2 Generation Consumption acceptance

On 2026-08-18, the `0.2.0` source target passed the packed exact-host scenario
against OpenClaw `2026.6.34 (5c38f99)` and Node.js `24.18.0`. The test installs a
fresh npm tarball into an isolated profile and proves the following closed path:

```text
Discovery Authorization -> Candidate Revision -> Telegram callback
  -> Change Set -> Git revision -> Generation build -> sync
  -> deep index + path-bound search/get -> next Eligible Run context
```

The same acceptance covers ordinary conversation, ended authorization, changed
base/checksum, unsupported channel, and natural-language approval rejection. It
also injects Host configuration, index, search-sentinel, interruption,
stale-Receipt, and config/index-drift failures, proving either prior-Generation
restoration or a closed new-Run gate. A public de-identified CangHai Instance
Test Pack verifies push-before-sync, legacy retrieval removal, `active-memory`
disablement, matching `USER.md`/`MEMORY.md` Bootstrap targets, and independent
Public Corpus continuity through the public Runner.

Reproduce the complete source-bound verification receipt for the checked-out
revision with:

```bash
npm run verify:env -- release --json
```

The `generation-consumption-public-runner` step uses the packaged public Runner
to execute the packed repository scenario and the public de-identified CangHai
Instance Test Pack in one acceptance process. The preceding exact-host step is
restricted to OpenClaw `2026.6.34 (5c38f99)` and Node.js `24.18.0`; a different
OpenClaw or Node build requires its own Compatibility Matrix row and evidence.

This dated source acceptance preceded publication and did not by itself prove a
registry release. `0.2.0` was subsequently published on 2026-08-20 from source
revision `4e0000f4227a9ec7bf12e9b9ac0d7ca87f2f515b`; registry integrity, tag,
GitHub Release, and exact-host receipts remain separately reportable evidence.

## Stable package acceptance

On 2026-08-12, `npm run test:pack-install` passed from the stable `0.1.0`
source tree against `OpenClaw 2026.6.34 (5c38f99)`. The test built a fresh npm
tarball, installed it through `npm-pack:` into an isolated synthetic OpenClaw
profile, inspected the loaded Plugin and strict config schema, discovered the CLI
and packaged Skill, exercised the verified host hooks and successor paths,
restarted the Gateway, uninstalled both probe Plugins, and confirmed byte-for-byte
restoration of the original isolated configuration.

The same command also passed tarball allowlist and sensitive-content scans plus
exact-tarball upgrade/integrity reproduction. It accessed no live Private
Instance. Registry publication, npm/GitHub attestations, tag correspondence, and
registry integrity are performed and checked by `release-stable.yml`; they are
not claimed by this local host record.

This document preserves the generic evidence that selected the first OpenClaw
adapter. Runtime development must not consult the historical private repository
or its machine-local spike files. Every future exact version requires a new
committed capability row and reproducible synthetic smoke.

## Capability matrix

| Capability | Result | Runtime consequence |
| --- | --- | --- |
| Five typed hooks with `run_id`, including fail-closed `before_agent_run` | pass | gate before the final Agent model request, then use the lifecycle hooks |
| Host-owned `llm.complete` | pass | use one bounded completion |
| Stable refs in memory result `content/details` | pass | parse through MemoryObservation adapter |
| `api.runContext.*` round trip | fail | use bounded in-process RunScratchMap |
| Native structured output | unavailable | JSON-only prompt plus strict local validation |
| Persisted-session embedded work admission | fail | do not call embedded runner directly |
| Host next-turn injection | fail | do not depend on it |
| Command continuation successor | pass | use normal host Agent loop |
| UI normal-RPC successor | pass | client submits after terminal barrier |
| Telegram deterministic callback context | pass | use `registerInteractiveHandler` with exact account, sender, conversation, and message identity |
| Telegram Review Artifact outbound seam | pass | use `runtime.channel.outbound.loadAdapter` and bind the returned send receipt |
| Bundled-only scheduled turn | unavailable to external Plugin | do not use it |

## Required adapter behavior

### Run correlation

`before_agent_run` performs the enforce-mode input gate before the final Agent
model request. `before_prompt_build` creates or reuses scratch keyed only by `run_id`.
`after_tool_call` records observations by `toolCallId`. Finalize may claim one
remediation. `agent_end` writes the bounded overlay and clears scratch. Reset,
disable, restart, TTL, and capacity paths also clear or reject deterministically.

### Router result

The host completion is asked for one JSON object. Runtime uses direct `JSON.parse`
without Markdown stripping or natural-language extraction, validates a closed
schema, then validates every ID, role, version, generation, and checksum against
the fixed Run registry. Failure degrades without a second completion.

The 2026.6.34 completion interface does not prove native schema-constrained output
or a `reasoning` control. V1 must not expose either as a supported option for this
matrix row.

### Correction successor

The accepted path is:

```text
correction + state_head + outbox transaction
  -> command continueAgent OR UI explicit normal RPC
  -> new host-owned Run
  -> before_prompt_build CAS claim
  -> receipt + new State View
  -> agent_end complete or release-to-pending
```

Synthetic focused smoke proved distinct Run IDs in one session, one non-terminal
outbox entry, transaction rollback, abort-to-pending, retry, duplicate correction
idempotency, one successful completion, and a UI terminal barrier. The guarantee
is at-least-once attempts with one successful completion, not cross-Run
exactly-once delivery.

## Rejected paths

- `sessionKey` scratch correlation: concurrent or queued Runs may share it.
- direct persisted-session `runEmbeddedAgent`: no verified work admission or host
  session lock ownership.
- bundled-only session scheduling: unavailable to an external Plugin.
- host next-turn injection: declared surface did not persist or create a Run in
  focused smoke.
- fire-and-forget, timer, or direct session-store writes: introduce races and
  violate host Agent-loop ownership.
- minimum-version feature inference: later or rolling documentation does not prove
  capability wiring in an exact installed build.

## Reproducible acceptance expectations

Pack-install smoke for this row must prove:

- `npm pack` allowlist and sensitive scan;
- real `npm-pack:` Plugin installation and runtime inspection;
- CLI and Plugin Skill discovery;
- hook correlation for plain and memory-tool Runs;
- strict Router happy and rejection cases;
- scratch concurrency, duplicate hooks, TTL, lifecycle, and capacity;
- correction commit, rollback, abort, retry, and command/UI successor flows;
- packed Candidate confirmation through the Telegram interactive callback context,
  with exact actor/message binding and no LLM execution;
- absence of calls to every rejected path;
- uninstall, configuration checksum restoration, and Gateway deep health.

The exact-host smoke dispatches the callback through the Gateway-owned
interactive registry. The outbound adapter contract is covered with a synthetic
Telegram send receipt; verification does not contact a private Telegram account.

All fixtures are synthetic. No live private Agent is accessed or modified.

## Primary public references

- [OpenClaw release policy](https://docs.openclaw.ai/reference/RELEASING)
- [OpenClaw release channels](https://docs.openclaw.ai/install/development-channels)
- [OpenClaw maturity scorecard](https://docs.openclaw.ai/maturity/scorecard)
- [Plugin hooks](https://docs.openclaw.ai/plugins/hooks)
- [Plugin runtime helpers](https://docs.openclaw.ai/plugins/sdk-runtime)
- [Agent loop](https://docs.openclaw.ai/concepts/agent-loop)
- [Command queue](https://docs.openclaw.ai/concepts/queue)
