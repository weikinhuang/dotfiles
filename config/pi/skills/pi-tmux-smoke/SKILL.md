---
name: pi-tmux-smoke
disable-model-invocation: true
description: >-
  WHAT: Drive the real `pi` TUI headlessly inside a tmux pane - boot it, send turns and slash commands with `send-keys`,
  read the rendered screen back with `capture-pane` - to smoke-test or observe behavior that only exists in an
  interactive session. WHEN: You need a real `/compact`, a slash command, an overlay (`/todos`, `/scratchpad`), a
  keybinding, or any extension behavior that the headless SDK can't reproduce, especially against a small model. DO-NOT:
  Use for anything scriptable through the SDK or `pi --print` (those are faster and assert on structured events, not
  screen scraping) - reach here only for genuinely interactive surfaces.
compatibility: >-
  Requires: tmux, a pi model to drive (select it with `pi --model provider/model`) with its provider credentials
  loadable in the pane. If the model is cheap or self-hosted, re-run flaky trials freely rather than trusting a single
  pane capture.
---

# pi tmux smoke test

`pi --print` is single-shot and the SDK scripts every turn - neither runs the **interactive** TUI, so neither can
exercise a real `/compact`, a slash command, an overlay, or a keybinding. To observe those you drive the actual `pi`
binary inside a detached tmux pane: type into it with `tmux send-keys`, read the rendered screen with
`tmux capture-pane`. This skill is the mechanics and the sharp edges.

Prefer the SDK or `pi --print` whenever the behavior is scriptable (see
[`../feature-eval-author/SKILL.md`](../feature-eval-author/SKILL.md) for the driver-choice table). tmux is the fallback
for interactive-only behavior; it is flakier because you assert on a screen scrape, not structured events.

## When to use this skill

Reach for a tmux-driven run when the thing under test **only manifests interactively**:

- A real `/compact` (and anything that arms on `session_before_compact`, e.g. the memory capture nudge).
- A slash command or overlay: `/todos`, `/scratchpad`, `/memory`, `/skill:<name>`.
- A keybinding, the editor, or any TUI affordance.
- An end-to-end "does the session even come up clean with these extensions" smoke check.

Stay on the SDK / `--print` for: save / recall / dedup / secret-gating (success = a file or a `toolResult` event), READ
/ ACT / SELECT probes, and anything you want to run at high N with exact scoring.

## Workflow

### 1. Source the env, in the pane

Loading your provider's credentials in the pane is mandatory: a fresh tmux shell does **not** inherit them - not even a
login shell. Load them in the **pane's** command line, not just the outer shell that calls `tmux`.

### 2. Boot, send, capture

```bash
source ~/.pi/agent/env 2>/dev/null || true   # outer shell: load creds if your setup keeps them there
S=pi-smoke-$$
MODEL=provider/model                         # e.g. anthropic/claude-haiku-4-5
tmux new-session -d -s "$S" -x 200 -y 50     # detached; give it a wide pane so output isn't truncated
tmux send-keys -t "$S" "{ source ~/.pi/agent/env 2>/dev/null || true; } && pi --model $MODEL" Enter
sleep 8                                       # let the TUI boot before typing the first turn
tmux send-keys -t "$S" 'first turn that establishes the fact' Enter
# Poll instead of guessing the turn length (see step 4):
tmux send-keys -t "$S" '/compact' Enter
sleep 12
# Assert, don't dump the screen: surface a one-word verdict, not 50 rows of TUI chrome (see "Token cost" below).
tmux capture-pane -t "$S" -p | grep -q "$TOKEN" && echo PASS || echo FAIL
tmux kill-session -t "$S"
```

To send a literal Enter as its own keypress (submit), pass `Enter` as a separate `send-keys` arg. To send text that
contains characters tmux treats specially, use `send-keys -l` (literal) for the text and a separate `Enter`.

### 3. Force a `/compact` on a short session

`/compact` throws **"Nothing to compact (session too small)"** before it emits `session_before_compact` whenever there's
nothing older than the kept window (`keepRecentTokens` defaults to 20000). To exercise compaction on a short smoke run:

- Point `PI_CODING_AGENT_DIR` at a temp dir of symlinks to `~/.pi/agent/*` **minus `settings.json`**, and write a
  `settings.json` there with `"compaction": { "enabled": true, "keepRecentTokens": 1 }`.
- Run **≥2 short turns** before `/compact` so there is a turn to summarize. (Use **≥3** if your check mines the
  compaction summary: a 1-turn forced compaction yields a split-turn summary - `## Original Request` /
  `## Early Progress` / `## Context for Suffix` - rather than the normal `## Goal` / `## Constraints & Preferences` /
  `## Key Decisions` shape.)

### 4. Assert on the pane - and beat the flake

`capture-pane -p` is a screen scrape, so timing is the main flake source. `sleep` is a guess; if trials are
inconsistent, **poll** until a sentinel appears instead of sleeping a fixed time:

```bash
for _ in $(seq 1 30); do
  tmux capture-pane -t "$S" -p | grep -q 'SENTINEL' && break   # prompt glyph, a tool-call line, a known token
  sleep 2
done
```

For state that the TUI does **not** render (e.g. a cache-safe `<system-reminder>` that is never persisted to the
transcript), screen-scraping won't see it. Observe it with temporary env-gated instrumentation inside the extension's
handler - `appendFileSync` to a debug path right after the inject call - run the smoke test, read the marker file, then
revert the instrumentation. **Commit real code first:** a stray `git checkout` to strip debug will wipe uncommitted work
on the same file.

## Keep the caller's token cost down

Every `capture-pane` you read flows into the **driving agent's** context, not the model-under-test. A wide, tall pane is
mostly blank rows and TUI chrome (borders, the input box, the status line, spinner frames) - pure token waste. Two facts
to calibrate against, both measured:

- `capture-pane -p` **already strips trailing whitespace** per line, so trailing-space bloat is a non-issue - no need
  for a `sed 's/ *$//'`.
- It emits **one line per pane row including blanks**, so a `-y 50` pane is ~49 mostly-empty lines even when the content
  is two lines. Pane _height and width_, not trailing spaces, are the bloat.

Levers, most effective first:

1. **Assert, don't read.** Pipe to `grep -q` and emit a one-word verdict (`PASS`/`FAIL`), or `grep -o "$TOKEN"` to
   surface only the match. The agent reads one token, not the screen. In a **poll loop**, `grep -q` produces zero output
   per iteration - only the final verdict reaches context.
2. **Capture only the region you need.** `| tail -n 8` (the recent output sits at the bottom), or bound the range with
   `capture-pane -p -S -12` (last 12 lines). Never read the full scrollback.
3. **Drop blank rows and chrome before it reaches context.** `| grep -vE '^\s*$'` removes the empty rows; add a
   `grep -vE 'box-drawing or status-bar pattern'` if your assertion still drags in chrome.
4. **Right-size the pane.** Use the smallest `-x`/`-y` that still fits the assertion without wrapping or truncating the
   target line. A 120x24 pane is far cheaper than 200x50; only go wide when a long line would otherwise wrap.
5. **Never pipe escape sequences in.** Omit `-e` (it's off by default) - escape codes multiply tokens and read as noise.
6. **Go out-of-band for long runs.** `capture-pane -p > /tmp/pane.txt` (or `tmux pipe-pane`) and then `grep`/`grep -A2`
   the FILE, surfacing only matches - so the raw screen never enters context at all.

## Anti-patterns

- **Forgetting to source env in the pane.** The session boots, the first turn hangs on a 401/timeout, and the pane looks
  "stuck" for no obvious reason.
- **Fixed `sleep`s as the only synchronization.** Works once, flakes the next run. Poll `capture-pane` for a sentinel.
- **Dumping the whole pane into context.** A raw `capture-pane -p` of a tall pane is mostly blank rows and chrome -
  `grep`/`tail` to a verdict instead (see "Keep the caller's token cost down").
- **Scraping for something the TUI never renders.** Cache-safe reminders, internal state - instrument the handler
  instead.
- **A too-narrow pane.** `capture-pane` returns the wrapped/truncated view; set `-x`/`-y` wide enough for your
  assertion.
- **Leaking sessions.** Always `tmux kill-session -t "$S"` (and clean the temp `PI_CODING_AGENT_DIR`) so a failed run
  doesn't leave a model-backed pane running.
- **Using tmux for scriptable behavior.** If success is a file on disk or a structured event, the SDK /
  `pi --print --mode json` is faster and far less flaky.

## References

- [`../feature-eval-author/SKILL.md`](../feature-eval-author/SKILL.md) - the eval playbook; driver-choice table (SDK vs
  `--print` vs tmux) and the READ-vs-ACT framing. This skill is its interactive fallback.
- [`extensions/memory.md`](../../extensions/memory.md) - the capture nudge (`PI_MEMORY_CAPTURE_TURN`) and what arms on
  `session_before_compact`, the canonical reason to need a real `/compact`.
