# OpenClaw extended-stable 2026.7.1-2 host evidence

> Exact build observed: `2026.7.1-2 (0790d9f)`
> Release target: `0.3.0` on Node.js `24.18.0`
> Previous rollback version: published `0.2.1`

## Source-bound packed acceptance

On 2026-08-28, the clean `0.3.0` source target was packed and installed into an
isolated OpenClaw home with the exact Host and Node versions above. The test
used synthetic Authority and Fitness data and pinned the clean Fitness source
revision `93612d25e65b631e20ab4a7ba51bf5011c2d1c0b`.

The executed public seam was:

```sh
STELLA_FITNESS_PACKAGE_ROOT="$FITNESS_CHECKOUT" \
STELLA_FITNESS_EXPECTED_REVISION=93612d25e65b631e20ab4a7ba51bf5011c2d1c0b \
node --test --test-concurrency=1 tests/pack-install/openclaw-discovery.test.mjs
```

It passed Plugin, CLI, and Skill discovery; Gateway restart continuity;
Candidate approval and publication; Generation synchronization and Host
index/search/get verification; next Eligible Run consumption; Fitness F1 to F2
desired-set replacement; destructive replacement gating; locator loss and
explicit restoration; fail-closed drift; and configuration restoration. The
current Host requires the test CLI to provide the explicit private Telegram
session key instead of inferring a route from `--channel` and `--to` alone.

The unified release profile remains:

```sh
npm run verify:env -- release --json
```

It includes the `generation-consumption-public-runner` profile and must run on
the immutable release commit. The stable workflow then repeats the exact-host
test after installing the published registry artifact and binds its integrity
to the workflow tarball and GitHub Release asset. Source acceptance alone does
not assert registry or GitHub Release delivery.
