---
name: feature-eval-author
disable-model-invocation: true
description: >-
  WHAT: Build a behavioral eval that drives a small model of your choice (any pi provider) headless through the pi SDK
  to measure whether a pi extension / feature actually changes model behavior - does the model READ injected state, ACT
  on an injected directive, or pick the right memory. WHEN: You added or changed a pi extension that injects context,
  nudges, recalls, or steers (memory, todo, scratchpad, capture, recall, guardrails) and want evidence it works on a
  small model, not just on a frontier one. DO-NOT: Use for unit logic that vitest already covers (pure reducers,
  formatters, scorers - test those offline), for frontier-model-only behavior, or for anything that does not need a live
  model in the loop.
compatibility: >-
  Requires: a pi model to drive (set `PI_EVAL_MODEL=provider/model`) with its provider credentials loaded, the pi SDK
  installed globally (@earendil-works/pi-coding-agent), and node 24+ (runs .ts via type-stripping). Pick a SMALL model -
  that is where the interesting failures live - and if it is cheap or self-hosted, prefer many small trials over one big
  one.
---

# Feature Eval Author

Unit tests (vitest) prove the _logic_ of a pi extension - reducers, formatters, scorers, selection. They cannot tell you
whether a real model, especially a small one, actually **reads the block you inject** or **acts on the nudge you fire**.
A behavioral eval drives the live model headless through the SDK and measures the behavior end to end.

This skill is the playbook: the harness anatomy, how to seed state cleanly, how to classify a trial, the gotchas that
cost hours, and how to read the result. Bundled, runnable starting points live in
[`scripts/instrument.mjs`](./scripts/instrument.mjs) (channel/timing/status instrumentation) and
[`scripts/eval-template.mjs`](./scripts/eval-template.mjs) (one parameterized trial). Copy the template to `/tmp`, edit
the seed + question + scorer, and drive it with a bash loop.

## The one distinction that decides everything: READ vs ACT

Small models behave very differently on the two things a pi extension can do. Decide which you are testing first - it
changes both the success signal and whether the feature can even work on a small model.

| Mode     | The feature…                                                                                                                          | Success signal                                    | Small-model verdict (measured on Qwen)                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **READ** | injects STATE into the turn (a `<system-reminder>` via the `context` hook: todo plan, scratchpad notes, recalled memory body, budget) | the model's answer reflects the injected fact     | **Reliable.** The model reads injected state and answers from it (todo 5/5, scratchpad 5/5, recall "tabs" 6/6).            |
| **ACT**  | injects a DIRECTIVE the model must execute (a capture nudge, a "save this" reminder, a steer) riding the next user turn               | a side effect happens (file written, tool called) | **Fails.** A small model ignores secondary injected directives (capture nudge 0/26) - it attends only to the primary turn. |

The lever for ACT on a small model is **turn placement, not wording**: deliver the directive as its OWN turn
(`pi.sendUserMessage(body, { deliverAs: 'followUp' })`) instead of a reminder on the user's turn (validated 5/5 vs
0/26). If your feature relies on the model acting on a tail `<system-reminder>`, the eval is there to expose that it
won't, and the fix is a dedicated turn or an auto-action - not a louder reminder. See `extensions/memory.md`
(`PI_MEMORY_CAPTURE_TURN`).

## When to use this skill

Reach for a behavioral eval when **all** hold:

- The feature's value depends on a model _doing_ something with what the extension injects/fires (reading state, acting,
  selecting), not just on the data structure being correct.
- You want to know whether it holds on the **small** model, where the interesting failures live.
- The behavior is observable: a token in the answer, a file on disk, a tool call, a ranking.

Stay offline (plain vitest, no model) for: reducer transitions, block formatting, search/scorer ranking quality
(`memory-search` MRR/P@1 is an offline metric over a fixture, not a live eval), env parsing.

## Pick a driver: SDK vs `--print` vs tmux

Three ways to put the live model in the loop. **Default to the SDK** - it gives seeded state, tight scoring, and cheap
high-N runs. Reach for the CLI drivers when you need the real session machinery the SDK fakes.

| Driver                                                              | Good for                                                                                                               | Can't do                                                   |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **SDK headless** (the template)                                     | READ / ACT / SELECT probes, seeded state, exact scoring, many cheap trials                                             | nothing interactive - you script every turn                |
| **`pi --print`** (one-shot; add `--mode json` for the event stream) | save / recall / dedup / secret-gating where success is a file on disk or a `tool_execution_*` / `toolResult` event     | won't `/compact` (single-shot); no overlays / keybindings  |
| **tmux interactive**                                                | behavior that only exists in the real TUI: a real `/compact`, the capture nudge actually firing, overlays, keybindings | flakier; you read the rendered pane, not structured events |

`--print` notes: isolate writes with `PI_MEMORY_ROOT=$(mktemp -d)`, and inspect with `--mode json` - dup-detection and
secret warnings live in the **tool RESULT** content (`toolResult` / `tool_execution_*`), not the user-facing text, so
plain `--print` text will miss them.

**tmux interactive behavior is its own skill.** When the thing under test only happens in a real session - a real
`/compact` (anything that arms on `session_before_compact`, e.g. the capture nudge), a slash command, or an overlay -
drive the actual TUI in a tmux pane per [`../pi-tmux-smoke/SKILL.md`](../pi-tmux-smoke/SKILL.md). It covers booting the
pane, `send-keys` / `capture-pane`, forcing a `/compact` on a short session (`keepRecentTokens: 1`), and observing
cache-safe (non-rendered) state via temporary instrumentation.

## Steps

### 1. Pick the mode and the observable

Write down, before any code: _"success = \<exact observable\>"_. Examples:

- READ: the answer contains the un-guessable token `Cobalt-7` that exists **only** in the injected block.
- ACT: a `memory save` file appears under a per-trial `PI_MEMORY_ROOT`; or a named tool shows up in `rec.tools`.
- SELECT: the recalled/ marked memory is the seeded target, not a distractor.

Use an **un-guessable token** (`Cobalt-7`, `mauve-walrus-7731`) so a hit cannot be the model inventing a plausible
answer. A real English answer the model could guess is not evidence the block was read.

### 2. Seed state so the fact lives ONLY where the feature puts it

The whole point is isolation: the model must have no _other_ source for the answer than the mechanism under test.

- **Branch-mirrored extensions (todo, scratchpad, bg-bash):** seed a custom entry **before** `bindExtensions` so
  `reduceBranch` picks it up and it never appears as a conversation tool-result:

  ```js
  const sm = SessionManager.inMemory(CWD);
  sm.appendCustomEntry('todo-state', {
    nextId: 3,
    todos: [
      /* … */
    ],
  }); // type strings: '<name>-state'
  sm.appendCustomEntry('scratchpad-state', {
    nextId: 2,
    notes: [
      /* … */
    ],
  });
  ```

  The entry shape `reduceBranch` accepts is `{ type:'custom', customType:'<name>-state', data }` - exactly what
  `appendCustomEntry(customType, data)` writes. Confirm the state shape against the reducer's `isShape` guard
  (`lib/node/pi/*-reducer.ts`).

- **`memory` recall:** write a valid memory FILE to a throwaway `PI_MEMORY_ROOT` via `fileFor()` + `serializeMemory()`.
  The scope+type must be VALID or `scanScope` silently skips it: `global` allows only `user`/`feedback` (not
  `reference`/`project`); `note` only in `session`. Make BOTH the directory-arg type and the frontmatter type valid and
  matching.

### 3. Build the session (the five things that are easy to get wrong)

Start from [`scripts/eval-template.mjs`](./scripts/eval-template.mjs). The load-bearing settings:

- `await session.bindExtensions({})` **after** `createAgentSession` - it does NOT fire `session_start` on its own, and
  without it the extension never runs its `session_start` handler (index/state stays empty, recall injects nothing). The
  `context` / `before_agent_start` handlers still fire (registered at module load), so a broken-looking recall is
  usually a missing `bindExtensions`.
- `thinkingLevel: 'off'` for QA-style probes - at low/high, a small model goes agentic (Qwen: 10-67 tool calls,
  repo-diving) and often never emits a final answer.
- `tools: []` to isolate "answer from injected context only".
- Empty `cwd` (e.g. `/tmp/pi-eval/empty`) - from a real repo the model bash-searches instead of using the injected
  block.
- `additionalExtensionPaths: [ … ]` loads ONLY the feature(s) under test. Use `loadPiSdk()` from `instrument.mjs` to
  find the dist without hardcoding a node version path.

### 4. Run one trial per process, in a bash loop

`session.dispose()` + a new session in the **same** process trips `titlebar-spinner` on a stale ctx and crashes the run
after trial 1. Spawn a fresh `node` per trial; add `process.on('unhandledRejection', () => {})` so a dangling aborted
`prompt()` after a stall doesn't crash. **Load your provider's credentials first** and select the model, then loop. Load
your provider's credentials into the shell first:

```bash
source ~/.pi/agent/env 2>/dev/null || true       # if your setup keeps creds there
export PI_EVAL_MODEL=provider/model              # e.g. anthropic/claude-haiku-4-5
for i in $(seq 1 5); do node eval-template.mjs "$i"; done
```

If you drive it from a tmux pane, load those credentials **inside that pane** too - a fresh tmux shell does not inherit
them.

### 5. Classify every trial, don't just pass/fail

Use `instrumentedAsk` + `fmtRec`. It records both model channels, timing, and a terminal status so a "0 content" trial
is explained, not mysterious:

| status            | meaning                                                                                           | what to do                                               |
| ----------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `ok`              | model finished normally                                                                           | score it                                                 |
| `length`          | hit `maxTokens`                                                                                   | raise the budget or tighten the prompt                   |
| `stall`           | no stream activity for `stallMs` → server hang (raw `curl /v1/chat/completions` returns HTTP 000) | restart / wait for the server; NOT a model failure       |
| `timeout`         | exceeded `timeoutMs` while still streaming                                                        | slow trial; raise timeout                                |
| `error` / `throw` | provider error / exception                                                                        | read `errorMessage`                                      |
| `repeat` flag     | same 3-gram 8+ times → degenerate loop                                                            | distinct from a stall (a loop streams; a hang is silent) |

Capture the **thinking** channel (`thinking_delta`), not just `text_delta` - a long-reasoning trial looks blank on
content alone while the model is fine.

### 6. Run a control / confound arm

A clean zero in the treatment arm is only meaningful against a control. For an ACT eval, run nudge-on vs nudge-off. To
rule out "the fact got summarized away" vs "the model won't act", add a **recall-probe** arm: after the same setup, ask
a neutral question whose answer is the fact - if the model answers it (the fact survived and was available) but still
didn't act, the failure is "ignores the directive", not "lost the fact". This is exactly how the capture 0/26 finding
was isolated.

## Interpreting results

- If your model is cheap or self-hosted, prefer n≥5 per arm (a clean 0/N or N/N is a strong signal at small N, a 3/5 is
  not); against a metered API, budget the N accordingly.
- READ working + ACT failing on the same feature is the expected small-model profile, not a bug - it tells you the
  feature should lean on state injection, and any directive needs its own turn.
- An offline selection metric (search MRR, recall P@1) answers "did it pick the right memory"; a live eval answers "did
  the model then USE it". Report them separately - strong selection + weak use is a real and common result.

## Anti-patterns

- **Guessable success token.** "tabs", "yes", a real filename - the model can produce these without reading the block.
  Use a nonsense token.
- **Leaving the fact in the conversation.** If the model called the tool to create the state this turn, the tool-result
  is right there - you're testing short-context recall, not the injected reminder. Seed via `appendCustomEntry` (or
  compact the turn away) so the reminder is the only surviving copy.
- **One big multi-trial process.** Crashes after trial 1 (session replacement). One process per trial.
- **Forgetting `bindExtensions`.** Looks like the feature is broken; it just never ran `session_start`.
- **`thinkingLevel` other than `off` for a QA probe.** Turns a 1-call answer into a 30-call repo dive.
- **Reading a `stall` as a model failure.** Check the server with a streaming `curl` before concluding the feature lost.
- **Concluding from the treatment arm alone.** Without a control / recall-probe you can't separate "won't act" from
  "lost the fact".

## References

- [`scripts/instrument.mjs`](./scripts/instrument.mjs) - channel/timing/status instrumentation + `loadPiSdk()`.
- [`scripts/eval-template.mjs`](./scripts/eval-template.mjs) - one parameterized READ trial; copy and edit.
- [`extensions/memory.md`](../../extensions/memory.md) - `PI_MEMORY_*` knobs, `PI_MEMORY_CAPTURE_TURN` (turn-delivery
  fix).
- [`extensions/todo.md`](../../extensions/todo.md) / [`extensions/scratchpad.md`](../../extensions/scratchpad.md) - the
  injected-block shapes.
- SDK example `packages/coding-agent/examples/sdk/13-session-runtime.ts` (in `~/source/pi`) - the canonical
  `bindExtensions` call.
