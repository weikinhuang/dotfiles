# `cost-guard`

Local-only warnings about sustained cache rewrites and expensive calls, ported from the pi
[`cost-guard`](../../../pi/extensions/cost-guard.md) extension. Detection is the shared pi detector in
[`lib/node/pi/cost-guard.ts`](../../../../lib/node/pi/cost-guard.ts); the opencode glue (usage mapping, replay, per-root
tracker, RPC payloads) is [`lib/node/opencode/cost-guard.ts`](../../../../lib/node/opencode/cost-guard.ts). Parts:
[`server.ts`](./server.ts) observes usage, [`tui.tsx`](./tui.tsx) shows toasts and a status contribution, and
[`rpc.ts`](./rpc.ts) is the contract between them.

## Detection

Each `session.step.ended` (or `session.step.failed` that carries usage) is one provider call with `tokens` (`input`,
`output`, `reasoning`, `cache.read`, `cache.write`) and one USD `cost`. The server maps it onto the pi sample: cache
reads, cache writes, prompt size (fresh + cached + written input), and call cost. The default conditions match pi:

- Cache-write dollars exceed 70% of session dollars after a full window.
- Positive reads vary by at most 2% while context grows over four calls. A strictly advancing read prefix is exempt.
- Cache writes exceed 50% of context for four calls.
- One call costs more than `$0.25`.
- Session cost crosses `$2`, `$5`, or `$10`.

State is kept per root session. Subagent (child session) calls and compactions add to the root's spend but not to its
rolling window, and never trip the per-call check. A model change resets the window. A committed revert clears the
window and open episodes but keeps spend and fired milestones.

One combined notification is emitted per call. Each condition fires once per episode and rearms after a full window of
healthy calls; milestones fire once per session. Plateau and rewrite notices are critical and suggest a fresh session or
compaction. A warning is not proof of prefix mutation.

opencode records a single `cost` per call with no breakdown, so cache-write dollars are estimated by splitting that cost
by the model's catalog prices (from `ctx.model.list()`). Without catalog pricing the write-share condition stays silent.

### Costs are estimates for some providers

For providers that do not report a charge, opencode computes `cost` from catalog list prices. GitHub Copilot is the
common case: opencode stores a nonzero estimated `cost` per message even though Copilot bills by subscription and
premium requests. Dollar thresholds (`callDollars`, `milestones`, the write share) therefore track list-price estimates,
not your bill. Token-only conditions (plateau, rewrite) are unaffected.

## Resume

There is no stored plugin state. The first time the server sees a root session (its first usage event, or the TUI asking
for its status when you open it), it silently replays that session's `ctx.session.context` messages: assistant messages
rebuild the window, open episodes, and fired milestones, and spend is seeded from `Session.Info.cost` of the root plus
its direct children (which also covers title and compaction usage before the last compaction). Replay never warns. The
event that triggered the replay is excluded from it and observed live, so a brand-new session still warns on its first
call. Plugin reloads (opencode reloads the entry file on edit) take the same path.

## Delivery

Nothing is model-bound: no session hooks, instructions entries, synthetic messages, or tools. The server pushes an
`update` event over the plugin's RPC (`dotfiles.cost-guard`) whenever a call produces new notices or the status level
changes. The TUI part shows the combined text as a toast (`warning`, or `error` when critical) and appends
`cost:warning` / `cost:critical` to the prompt footer status row (`prompt.footer.status`) of the session's tree. When a
session's prompt first renders, the TUI calls the `status` method, which triggers the silent replay, so a reopened
session shows its status without a toast.

Without a TUI (for example `opencode run` or an external client), the only output is the optional `log` file.

## Options

Set options with a plugin entry in `opencode.jsonc` (see [Install](../README.md#install)). Every option also has an
`OPENCODE_COST_GUARD_*` environment override, which wins over the option.

| Option              | Env override                              | Default      | Effect                                                         |
| ------------------- | ----------------------------------------- | ------------ | -------------------------------------------------------------- |
| `enabled`           | `OPENCODE_COST_GUARD_ENABLED`             | `true`       | `false` disables the plugin entirely.                          |
| `window`            | `OPENCODE_COST_GUARD_WINDOW`              | `4`          | Calls for sustained conditions and recovery; clamped to 2-100. |
| `readTolerance`     | `OPENCODE_COST_GUARD_READ_TOLERANCE`      | `0.02`       | Read-prefix variation and minimum context growth fraction.     |
| `writeContextRatio` | `OPENCODE_COST_GUARD_WRITE_CONTEXT_RATIO` | `0.5`        | Sustained write / context fraction; `0` disables.              |
| `writeCostRatio`    | `OPENCODE_COST_GUARD_WRITE_COST_RATIO`    | `0.7`        | Session cache-write dollar share; `0` disables.                |
| `callDollars`       | `OPENCODE_COST_GUARD_CALL_DOLLARS`        | `0.25`       | Per-call USD warning; `0` disables.                            |
| `milestones`        | `OPENCODE_COST_GUARD_MILESTONES`          | `[2, 5, 10]` | Session USD thresholds; `[]`, `false`, or `none` disables.     |
| `log`               | `OPENCODE_COST_GUARD_LOG`                 | unset        | Append warnings and diagnostics (seed, observe) to this file.  |

`milestones` takes a number array or a comma-separated string. Ratios must be within 0-1; invalid, negative, or
out-of-range values fall back to the default (the pi validation rules). Booleans accept `true` / `false` or the dotenv
`1` / `0`, `yes` / `no`, `on` / `off` words.

## Limitations

- Sub-cent amounts print as `$0.00` (the shared pi text uses two decimals).
- Replay seeds child spend from direct children only; grandchild sessions created before the replay are not counted.
- Title and `generate` usage after the replay are not observed (opencode records them through an internal event that
  never reaches plugins).
- The TUI only shows events while connected; RPC events are live-only, but the `status` call on render catches up.
- opencode watches only the plugin entry files; restart opencode after editing the `lib/node/` helpers.

## Live test

```bash
./dev/opencode-plugin-smoke.sh start -n cg \
  -o 'cost-guard={"callDollars":0.00001,"milestones":[0.00002],"window":2,"log":"/tmp/opencode-smoke-cg/cg.log"}' \
  cost-guard
./dev/opencode-plugin-smoke.sh send cg 'Reply with exactly: READY'
./dev/opencode-plugin-smoke.sh wait cg '^ +READY'
./dev/opencode-plugin-smoke.sh capture cg 30   # "Cost guard" toast plus cost:warning in the footer
./dev/opencode-plugin-smoke.sh send cg 'Reply with exactly: AGAIN'
./dev/opencode-plugin-smoke.sh wait cg '^ +AGAIN'
cat /tmp/opencode-smoke-cg/cg.log              # second call: no repeat of the per-call warning
./dev/opencode-plugin-smoke.sh stop cg
```
