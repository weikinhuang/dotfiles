# pi session inspection without conversation content

[`ai-session-inspect`](../../../dotenv/bin/ai-session-inspect) reports the structure of one pi session for debugging
context loss, recap coverage, and window cutoffs. The output is safe to hand to a model when the session itself holds
private content. It runs locally and makes no model or network calls.

```sh
ai-session-inspect                       # newest pi session
ai-session-inspect 01a1949b --turns      # by id prefix, with a per-turn table
ai-session-inspect 01a1949b --all        # + recaps, checkpoints, audits, compactions, snapshot sizes
ai-session-inspect path/to/session.jsonl --json --no-ids
```

## What is reported

- **Totals**: records, active-branch length, branch count, malformed lines, user turns, responses, tool calls,
  compactions, model changes, recap and checkpoint counts.
- **Per turn**: character counts of user text, assistant text, thinking, and tool results; prompt tokens (input plus
  cache read/write) of the first and peak response; output tokens; stop reason; stored reminder-snapshot size; recap
  events; and the roleplay window debug cutoffs (`messagesIn` / `messagesOut`, `natural`, `recapCutoff`, `floorCutoff`,
  `dropCutoff`) when `PI_ROLEPLAY_CONTEXT_DEBUG=1` recorded them.
- **Roleplay audits**: recap rolls (mode, applied / forced / trivial, coverage range, span, prior / candidate / recap
  sizes, duration, anchor turn), window checkpoints (version, chars/token, floor anchors resolved to turns), timeline
  and capture outcomes, and compactions (summary size, tokens before, first kept turn).
- **Findings**: deterministic heuristics with turn numbers. `uncovered-drop` and `history-collapse` flag history removed
  beyond recap coverage. `prompt-shrink` flags an unexplained fall in request size. Calibration below 2.5 chars/token, a
  saved floor at the latest turn, failed safety recaps, recap stalls, coverage regressions, legacy checkpoints, and
  errored responses are also reported. Findings are leads, not proof.

Analysis follows the active root-to-leaf path ending at the most recently appended entry; abandoned forks are counted
but not analyzed.

## Privacy contract

The report is constructed field by field from an allowlist in [`session-inspect.ts`](../pi/session-inspect.ts). It
contains only numbers, booleans, fixed enumerations, finding text composed from numbers, and identifiers that pass
strict patterns: tool, model, provider, custom entry, and reminder spec names. Message and thinking text, tool arguments
and results, system prompt sections, compaction and branch summaries, recap, candidate, and timeline text, reminder
bodies, labels, session names, and the session `cwd` are never copied; only their sizes appear. Cast names are
user-chosen and are always replaced by ordinals (`cast-1`). Identifiers that fail their pattern become
`<category>-redacted`; `--no-ids` replaces every identifier with an ordinal.

[`session-inspect-cli.ts`](./session-inspect-cli.ts) prints only that report or messages it authors. It never echoes
file paths, JSON parser excerpts, or filesystem error text. Specs exercise every text-bearing field with a marker and
assert it never reaches any output mode.
