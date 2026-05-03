# `read-reread-detector.ts`

Second-layer companion to [`loop-breaker`](./loop-breaker.ts). That extension catches identical `(toolName, input)`
hashes repeating inside a short window; this one catches the broader small-model failure mode of `read`-ing the same
file 3–5 times across a task — once to orient, again after forgetting, again after a follow-up prompt.

For every successful `read`, the extension `statSync`s the file and records a `(absPath, mtimeMs, size)` signature plus
the offset/limit the model asked for and the current turn. On any subsequent `read` of the same path we classify:

- **first-time** — unseen path → pass through.
- **same-slice** — same path + unchanged signature + same offset/limit → append a nudge naming the slice, when it was
  first read, and pointing at `scratchpad` for carry-over.
- **different-slice** — same path + unchanged signature + different window → softer nudge suggesting
  `rg -n "<pattern>" <path>` or `scratchpad` for incremental capture.
- **changed** — mtime or size differs → silent, update the signature.

The turn counter only bumps on REAL user input — extension-synthesized messages (`source: "extension"`) don’t count, so
“N turns ago” stays semantically correct when other extensions inject steers between turns.

Pure logic (history store, classification, nudge formatting) lives in
[`lib/node/pi/read-reread.ts`](../../../lib/node/pi/read-reread.ts) so it can be unit-tested under `vitest` without
pulling in the pi runtime.

## Environment variables

- `PI_READ_REREAD_DISABLED=1` — skip the extension entirely.
- `PI_READ_REREAD_MAX_ENTRIES=N` — cap on tracked files (default `256`, insertion-order eviction).
- `PI_READ_REREAD_DEBUG=1` — `ctx.ui.notify` on every decision.
- `PI_READ_REREAD_TRACE=<path>` — append one line per decision to `<path>`.

## Hot reload

Edit [`extensions/read-reread-detector.ts`](./read-reread-detector.ts) or
[`lib/node/pi/read-reread.ts`](../../../lib/node/pi/read-reread.ts) and run `/reload` in an interactive pi session.
