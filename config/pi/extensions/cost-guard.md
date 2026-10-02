# `cost-guard.ts`

Warn locally about sustained cache rewrites and expensive calls without adding any provider-bound text.

## Detection

After assistant completion, [`cost-guard.ts`](../../../lib/node/pi/cost-guard.ts) retains a bounded rolling window of
cache reads, writes, prompt size (fresh + cached + written input), and turn cost. Observed usage is authoritative for
all providers. Nested tool usage contributes to session cost, but not the assistant rolling window. Resume silently
replays recorded accounting, including usage/compaction entries; fresh sessions start empty. Branch navigation clears
the rolling window while retaining actual session spend.

Default conditions:

- Cache-write dollars exceed 70% of session dollars after a full window.
- Positive reads vary by at most 2% while context grows over four calls. A strictly advancing read prefix is exempt.
- Cache writes exceed 50% of context for four calls.
- One call costs more than `$0.25`.
- Cumulative session cost crosses `$2`, `$5`, or `$10`.

One combined notification is emitted per response, with each condition deduplicated during its episode. A condition
rearms after four healthy assistant calls; milestones fire once per session. Sustained plateau/rewrite notices are
critical and recommend a fresh session, compaction, or reviewing named active auto-injectors. A warning is not proof of
mutation: tracing can distinguish unchanged payloads from local prefix changes. No circuit breaker mutates state.

## Local-only delivery

`ctx.ui.notify` and the `cost-guard` status slot are the only warning surfaces. There is no context hook, prompt
addendum, tool schema, `sendMessage`, or provider call. Warnings cannot add tokens to the model prompt. Print/headless
modes without a UI still maintain diagnostic state but do not emit warnings. Shutdown clears the status and state.

## Environment variables

| Variable                            | Default  | Meaning                                                                  |
| ----------------------------------- | -------- | ------------------------------------------------------------------------ |
| `PI_COST_GUARD_DISABLED=1`          | unset    | Complete disable; registers nothing                                      |
| `PI_COST_GUARD_WINDOW`              | `4`      | Calls required for sustained conditions and recovery; bounded to 2..100  |
| `PI_COST_GUARD_READ_TOLERANCE`      | `0.02`   | Read-prefix variation and minimum context growth fraction                |
| `PI_COST_GUARD_WRITE_CONTEXT_RATIO` | `0.5`    | Sustained write/context fraction; `0` disables this condition            |
| `PI_COST_GUARD_WRITE_COST_RATIO`    | `0.7`    | Session write-dollar share; `0` disables this condition                  |
| `PI_COST_GUARD_CALL_DOLLARS`        | `0.25`   | Per-call USD warning; `0` disables this condition                        |
| `PI_COST_GUARD_MILESTONES`          | `2,5,10` | Sorted, deduplicated positive USD thresholds; `none` disables milestones |

Invalid/nonfinite/negative values fall back to defaults. Ratios must be within 0..1. Missing costs are not guessed from
provider pricing; token-only sustained conditions can still be detected. Historical costs are not rewritten.

## Verification and hot reload

Pure tests cover the sanitized incident within four bad calls, healthy advancing cache, bounded retention, recovery,
model/session reset, silent accounting replay, malformed usage, thresholds, and notification deduplication. Editing the
extension/helper or changing environment variables requires `/reload`. No paid smoke test has been run.
