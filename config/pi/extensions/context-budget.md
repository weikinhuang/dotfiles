# `context-budget.ts`

Surfaces the model’s own context-window usage **inside its system prompt** each turn. Pi’s statusline already shows
`N% left` to the user, but the model doesn’t see the statusline - it only sees the system prompt. Without this
extension, weaker models happily chain a dozen broad `read`s / `rg` calls until the window is nearly full. With it, each
turn’s system prompt ends with a one-line advisory that both reports the number AND points at the remediation.

## Tone bands

Rendered by [`lib/node/pi/context-budget.ts`](../../../lib/node/pi/context-budget.ts). Percent is computed from
`ctx.getContextUsage()` (`tokens / contextWindow`). Thresholds are configurable via env vars.

| Usage                    | Injected? | Tone                                                                                                               |
| ------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------ |
| `< minPercent` (<50%)    | no        | Casual chats and early-session work don’t need the nag.                                                            |
| `min–warn` (50–80%)      | yes       | “Context: N% used (… tokens left of K). Prefer targeted `rg` with patterns over broad reads; use `read --offset`…” |
| `warn–critical` (80–90%) | yes       | “… Be efficient with tool output - favor targeted `rg`/`grep` over broad reads…”                                   |
| `≥ critical` (≥90%)      | yes       | “… You are running out of context - finish what’s essential now … Consider `/compact` if you need more room.”      |

One-line format keeps signal-per-token high; token counts render via `formatTokens` (e.g. `45k`, `1.23M`) so they match
the statusline.

## Optional auto-compaction

When `PI_CONTEXT_BUDGET_AUTO_COMPACT_PERCENT` is set, the extension calls `ctx.compact()` once when usage
**edge-triggers** across the threshold (previous turn below, current turn at or above). Edge-triggering protects against
re-compacting every turn while sitting above the line. After a successful compaction drops usage back below the
threshold, the trigger re-arms for long sessions. Off by default - auto-compact is a big hammer; the advisory line is
often enough on its own.

## Commands

- `/context-budget` (or `/context-budget preview`) - shows the current usage, thresholds, auto-compact state, and the
  **exact advisory line** that would be appended to the next turn's system prompt (or an explanatory "no advisory would
  be injected (reason: usage X% is below min-percent Y%)" message when silent). Useful for answering "am I actually
  below the threshold?" and "which tone band am I in right now?" without reading extension code.

## Environment variables

- `PI_CONTEXT_BUDGET_DISABLED=1` - skip the extension entirely.
- `PI_CONTEXT_BUDGET_MIN_PERCENT=N` - start injecting at `N%` (default `50`).
- `PI_CONTEXT_BUDGET_WARN_PERCENT=N` - switch to “be efficient” tone at `N%` (default `80`).
- `PI_CONTEXT_BUDGET_CRITICAL_PERCENT=N` - switch to “running out” tone at `N%` (default `90`).
- `PI_CONTEXT_BUDGET_AUTO_COMPACT_PERCENT=N` - auto-compact when usage edge-crosses `N%`. Unset = off.
- `PI_CONTEXT_BUDGET_AUTO_COMPACT_INSTRUCTIONS=TEXT` - extra instructions passed to `ctx.compact()` when auto-triggered.

## Hot reload

Edit [`extensions/context-budget.ts`](./context-budget.ts) or
[`lib/node/pi/context-budget.ts`](../../../lib/node/pi/context-budget.ts) and run `/reload` in an interactive pi
session.
