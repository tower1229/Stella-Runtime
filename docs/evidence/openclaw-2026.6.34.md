# OpenClaw extended-stable 2026.6.34 host evidence

> Status: accepted first-host baseline
> Exact build observed: `2026.6.34 (5c38f99)`
> Package version: `0.1.0`

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

| Capability | Result | V1 consequence |
| --- | --- | --- |
| Four typed hooks with `run_id` | pass | use the typed hooks |
| Host-owned `llm.complete` | pass | use one bounded completion |
| Stable refs in memory result `content/details` | pass | parse through MemoryObservation adapter |
| `api.runContext.*` round trip | fail | use bounded in-process RunScratchMap |
| Native structured output | unavailable | JSON-only prompt plus strict local validation |
| Persisted-session embedded work admission | fail | do not call embedded runner directly |
| Host next-turn injection | fail | do not depend on it |
| Command continuation successor | pass | use normal host Agent loop |
| UI normal-RPC successor | pass | client submits after terminal barrier |
| Bundled-only scheduled turn | unavailable to external Plugin | do not use it |

## Required adapter behavior

### Run correlation

`before_prompt_build` creates or reuses scratch keyed only by `run_id`.
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
- absence of calls to every rejected path;
- uninstall, configuration checksum restoration, and Gateway deep health.

All fixtures are synthetic. No live private Agent is accessed or modified.

## Primary public references

- [OpenClaw release policy](https://docs.openclaw.ai/reference/RELEASING)
- [OpenClaw release channels](https://docs.openclaw.ai/install/development-channels)
- [OpenClaw maturity scorecard](https://docs.openclaw.ai/maturity/scorecard)
- [Plugin hooks](https://docs.openclaw.ai/plugins/hooks)
- [Plugin runtime helpers](https://docs.openclaw.ai/plugins/sdk-runtime)
- [Agent loop](https://docs.openclaw.ai/concepts/agent-loop)
- [Command queue](https://docs.openclaw.ai/concepts/queue)
