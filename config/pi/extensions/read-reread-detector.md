# `read-reread-detector.ts`

Second-layer companion to [`loop-breaker`](./loop-breaker.ts). That extension catches identical `(toolName, input)`
hashes repeating inside a short window; this one catches the broader small-model failure mode of `read`-ing the same
file 3–5 times across a task - once to orient, again after forgetting, again after a follow-up prompt.

For every successful `read`, the extension `statSync`s the file and merges the line range the read **actually returned**
into per-`(absPath, mtimeMs, size)` coverage: a small sorted set of 1-based line intervals (overlapping and adjacent
intervals merge; at most 32 per file, least-recently-read dropped first). The returned range comes from the `read`
result's `details.truncation.outputLines`, else the trailing `Use offset=N to continue.` footer, else the returned line
count, so a truncated open-ended read records `1-604`, not "to EOF". A result with no lines (first line over the byte
limit) is ignored. On any subsequent `read` of the same path we classify:

- **first-time** - unseen path → pass through.
- **changed** - mtime or size differs → silent, coverage resets to the new read.
- **continuation** - the read starts right after a covered interval (the tool's own `Use offset=N to continue` hint) →
  silent, even if the window runs into later coverage.
- **disjoint** - no covered line → silent (paging through separate windows).
- **partial-overlap** - under 50% of the returned lines were already covered → silent.
- **overlap** - at least 50% of the returned lines were already covered → nudge naming the covered lines
  (`lines 400-960 already in context`) and suggesting `rg -n "<pattern>" <path>` or `scratchpad` for incremental
  capture.
- **same-slice** - fully covered and the same offset/limit (or returned range) as the previous read → sharper nudge
  naming the slice, the covered lines, when it was last read, and pointing at `scratchpad` for carry-over.

Repeated full re-reads of an unchanged file (the 3-5x small-model loop) stay **same-slice** and keep nudging. "N turns
ago" uses the most recent turn that touched the overlapping lines.

Reads made by another tool through `ctx.executeTool()` carry `parentToolCallId` and are ignored. They do not update the
history or receive model-facing nudge text, so codemode scripts get the unmodified programmatic result.

The turn counter only bumps on a genuinely fresh idle user prompt - extension-synthesized messages
(`source: "extension"`) and pi-0.77.0+ mid-stream steers / queued follow-ups (`InputEvent.streamingBehavior` of
`"steer"` / `"followUp"`) don’t count, so “N turns ago” stays semantically correct when other extensions inject steers
between turns or when the user adds a mid-turn correction. The shared predicate is
[`isFreshUserPrompt`](../../../lib/node/pi/input-event.ts).

Pure logic (history store, classification, nudge formatting) lives in
[`lib/node/pi/read-reread.ts`](../../../lib/node/pi/read-reread.ts) so it can be unit-tested under `vitest` without
pulling in the pi runtime.

## Environment variables

- `PI_READ_REREAD_DISABLED=1` - skip the extension entirely.
- `PI_READ_REREAD_MAX_ENTRIES=N` - cap on tracked files (default `256`, insertion-order eviction).
- `PI_READ_REREAD_DEBUG=1` - `ctx.ui.notify` on every decision.
- `PI_READ_REREAD_TRACE=<path>` - append one line per decision to `<path>`.

## Hot reload

Edit [`extensions/read-reread-detector.ts`](./read-reread-detector.ts) or
[`lib/node/pi/read-reread.ts`](../../../lib/node/pi/read-reread.ts) and run `/reload` in an interactive pi session.
