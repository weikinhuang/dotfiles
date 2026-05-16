# `read-without-limit-nudge.ts`

Low-false-positive steer for `read` calls that skip `offset`/`limit` on files large enough to warrant a targeted
approach. Pi’s `read` tool already caps output at 2000 lines / 50 KB; this extension tells the model “for files this
size, `rg -n` or a windowed `read` would have been the better first move” so the NEXT call is tighter.

Signal sources (in priority order):

1. Pi’s own `details.truncation.totalLines` / `.totalBytes`. Populated when pi truncated or the user’s `limit` stopped
   early - the strongest signal.
2. Fallback: when pi didn’t populate truncation (file fit inside the default caps), `statSync` the file and synthesize a
   `TruncationLike` from byte size. Line count isn’t cheap without re-reading, so the fallback path is byte-only.

Decision rules (OR together - whichever triggers first):

- Skip when `offset` or `limit` is already present, or pi already reported truncation (pi’s own
  `[Showing lines X-Y of Z…]` footer already steers).
- Nudge when `totalLines >= minLines` (default `400`) OR `totalBytes >= minBytes` (default `20480`).

The nudge is appended as a second text part, leaving pi’s original content untouched at index 0. Composes with
[`extensions/read-reread-detector.ts`](./read-reread-detector.md) (which also appends) and with
[`extensions/tool-output-condenser.ts`](./tool-output-condenser.md) (which rewrites only the first text part).

## Environment variables

- `PI_READ_LIMIT_NUDGE_DISABLED=1` - skip the extension entirely.
- `PI_READ_LIMIT_NUDGE_MIN_LINES=N` - nudge threshold in lines (default `400`).
- `PI_READ_LIMIT_NUDGE_MIN_BYTES=N` - nudge threshold in bytes (default `20480` = 20 KB).
- `PI_READ_LIMIT_NUDGE_DEBUG=1` - `ctx.ui.notify` on every decision.
- `PI_READ_LIMIT_NUDGE_TRACE=<path>` - append one line per decision to `<path>`.

## Hot reload

Edit [`extensions/read-without-limit-nudge.ts`](./read-without-limit-nudge.ts) or
[`lib/node/pi/read-limit-nudge.ts`](../../../lib/node/pi/read-limit-nudge.ts) and run `/reload` in an interactive pi
session.
