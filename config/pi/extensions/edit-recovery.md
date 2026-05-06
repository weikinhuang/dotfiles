# `edit-recovery.ts`

Appends a recovery block to `edit` tool errors when `oldText` didn't match the file verbatim. Aimed at small self-hosted
models that paraphrase leading indentation, collapse whitespace runs, or swap tabs for spaces — their edits regularly
fail pi's fuzzy-match pass and without help they retry the same near-identical garbage two or three times before giving
up.

## What it does

On every `tool_result` where the tool is `edit` and `isError: true`:

1. Parse pi's `Could not find the exact text …` error shape via
   [`parseEditFailure`](../../../lib/node/pi/edit-recovery.ts). Bail on unrecognized error shapes.
2. Re-read the target file (capped at `PI_EDIT_RECOVERY_MAX_BYTES`, default 256 KB).
3. Run an aggressive whitespace-insensitive search via [`locateAndFormat`](../../../lib/node/pi/edit-recovery.ts) to
   re-locate the intended region, with surrounding context lines and a `>>` marker on the likely candidate.
4. Append the recovery block as a second text part so pi's original error stays at position 0. Composes cleanly with
   downstream `tool_result` handlers (e.g. [`tool-output-condenser.ts`](./tool-output-condenser.md)).

Auto-retry is deliberately **not** attempted — that hides the fault from
[`verify-before-claim.ts`](./verify-before-claim.md) / [`stall-recovery.ts`](./stall-recovery.md) /
[`todo.ts`](./todo.md) guardrails and masks "model didn't understand what it was doing" failures. Surfacing the actual
file content lets the model succeed on the retry without losing the honest turn shape.

## Outcome kinds

Returned by [`locateAndFormat`](../../../lib/node/pi/edit-recovery.ts); shapes the recovery block:

| `kind`       | Condition                                                 | Recovery guidance               |
| ------------ | --------------------------------------------------------- | ------------------------------- |
| `exact-1`    | Single unambiguous whitespace-equivalent region found.    | Confident retry guidance.       |
| `exact-many` | Multiple whitespace-equivalent regions found.             | Tell model to disambiguate.     |
| `anchor`     | No full-block match, but first line of `oldText` appears. | Point at possible anchor lines. |
| `no-match`   | Whitespace-insensitive search also fails.                 | "Re-read or `grep` first".      |
| `unreadable` | File missing / too large / unreadable.                    | "Read the file yourself".       |

## Environment variables

- `PI_EDIT_RECOVERY_DISABLED=1` — skip the extension entirely.
- `PI_EDIT_RECOVERY_MAX_BYTES=<n>` — max file size to scan (default `262144` = 256 KB). Larger files bail with
  `kind=unreadable`.
- `PI_EDIT_RECOVERY_CONTEXT_LINES=<n>` — lines of context above/below each candidate (default `2`).
- `PI_EDIT_RECOVERY_MAX_CANDIDATES=<n>` — cap per-result (default `5`) to keep the recovery block bounded.
- `PI_EDIT_RECOVERY_DEBUG=1` — `ctx.ui.notify` each decision.
- `PI_EDIT_RECOVERY_TRACE=<path>` — append one line per decision to `<path>`. Useful in `-p` / RPC mode.

## Hot reload

Edit [`extensions/edit-recovery.ts`](./edit-recovery.ts) or
[`lib/node/pi/edit-recovery.ts`](../../../lib/node/pi/edit-recovery.ts) and run `/reload` in an interactive pi session
to pick up changes without restarting.
