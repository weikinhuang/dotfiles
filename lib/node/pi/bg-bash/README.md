# bg-bash module layout

`bg_bash` ([`../../../../config/pi/extensions/bg-bash.ts`](../../../../config/pi/extensions/bg-bash.ts)) is the one
extension whose pure helpers are deliberately split across two locations. This note records which half a change belongs
in; see [`../AGENTS.md`](../AGENTS.md) for the subtree-wide pi-import policy.

## Engine (top-level `lib/node/pi/bg-bash-*.ts`) vs adapters (this `bg-bash/` subdir)

- **Top-level `bg-bash-*.ts` = the per-job engine (the data path).** The bounded in-memory ring buffer
  ([`../bg-bash-ring.ts`](../bg-bash-ring.ts)) -> stream read semantics ([`../bg-bash-stream.ts`](../bg-bash-stream.ts))
  -> pure state reducer ([`../bg-bash-reducer.ts`](../bg-bash-reducer.ts)) -> its renderers
  ([`../bg-bash-format.ts`](../bg-bash-format.ts) job/overlay lines, [`../bg-bash-prompt.ts`](../bg-bash-prompt.ts)
  system-prompt block).
- **This `bg-bash/` subdir = leaf adapters the extension shell composes around the engine.** Config coercion
  ([`config.ts`](./config.ts)), start-cwd resolution ([`resolve-cwd.ts`](./resolve-cwd.ts)), the accepted signal set
  ([`signals.ts`](./signals.ts)), tool-result text ([`results.ts`](./results.ts)), the completion nudge
  ([`nudge.ts`](./nudge.ts)), and the `/bg-bash` usage string ([`usage.ts`](./usage.ts)).

Rule of thumb: a change touching buffering, stream reads, or reducer state belongs in the engine (top-level); a change
to config, cwd, signals, or result/nudge/usage text belongs in a `bg-bash/` leaf.

## The one shared concern: LLM-facing string shaping

`results.ts` shapes the `start` / `logs` / `wait` tool results and defers per-job line rendering to
`../bg-bash-format.ts`'s `formatJobLine` (its header records the shared contract). Keep new job-line / overlay rendering
in `bg-bash-format.ts` and new per-action result prose in `results.ts` - don't duplicate a formatter across the two.
