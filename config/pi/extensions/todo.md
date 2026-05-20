# `todo.ts`

Plan-driven tracking tool tuned for weak-model support. Ships a single `todo` tool with eight actions, the `/todos`
overlay, system-prompt auto-injection of the active plan every turn, and a completion-claim guardrail that nudges the
agent off premature "all done" sign-offs while items are still open.

## What it does

Builds on pi's stock `examples/extensions/todo.ts` with three weak-model affordances:

1. **Richer state model.** Six statuses (`pending`, `in_progress`, `review`, `completed`, `blocked`, `cancelled`) with
   hard invariants: at most one item `in_progress` and at most one in `review` at a time. Serial focus is the behaviour
   weaker models need trained into them - silently allowing parallel work produces drift-prone plans.
2. **System-prompt auto-injection** (`before_agent_start`). The current `in_progress` + `review` + `pending` + `blocked`
   + `cancelled` list is appended to the system prompt every turn, rendered by
   [`formatActivePlan`](../../../lib/node/pi/todo-prompt.ts). Survives `/compact` and long contexts without the model
   having to remember to call `list` on its own.
3. **Completion-claim guardrail** (`agent_end`). If the assistant signs off as "done" (heuristic in
   [`looksLikeCompletionClaim`](../../../lib/node/pi/todo-prompt.ts)) while `in_progress` / `review` / `pending` items
   still exist, a follow-up user message is injected nudging it to finish, `block`, or `cancel` the open items.
   Idempotent: the steer carries a sentinel marker and re-fires only once per turn.

## Tool: `todo`

| Action     | Required           | Optional | Notes                                                                                                                                                                                                                                                |
| ---------- | ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`     | -                  | -        | Dumps the full state via `formatText`. Read-only.                                                                                                                                                                                                    |
| `add`      | `text` or `items`  | -        | Appends one or many todos. Use `items` for the initial multi-step plan; whitespace-only entries are skipped.                                                                                                                                         |
| `start`    | `id`               | -        | Marks the todo `in_progress`. Errors if another item is already `in_progress`. Idempotent if `id` is already running. Pulls a `review` item back into `in_progress` (e.g. for another pass) and clears the review-era note.                          |
| `review`   | `id`               | `note`   | Parks an `in_progress` item awaiting verification. Only `in_progress` items can enter review (call `start` first). At most one item in `review` at a time. Idempotent: re-calling on the same id updates the note.                                   |
| `complete` | `id`               | `note`   | Marks the todo `completed`. From `in_progress` directly the `note` is required (describe what verified the outcome). From `review` the `note` is optional - the review step was the verification parking. Clears prior notes when no note is given. |
| `block`    | `id`, `note`       | -        | Marks the todo `blocked`. Use when work is still needed but parked on an external dependency (waiting on review, broken upstream, missing data). The `note` explains what is being waited on.                                                        |
| `cancel`   | `id`, `note`       | -        | Marks the todo `cancelled`. Use when the item is no longer in scope (superseded, duplicate, pivoted, no longer relevant). The `note` explains why. Rejects `completed` items - call `reopen` first if you really need to cancel one.                 |
| `reopen`   | `id`               | -        | Restores the todo to `pending` and clears any note. Accepts a source in `completed`, `blocked`, or `cancelled`; pending / in_progress / review items are reopened as a no-op-with-note-clear.                                                        |
| `clear`    | -                  | -        | Empties state and resets `nextId`. Use sparingly: the active plan is the LLM's external memory across turns.                                                                                                                                         |

## State model and transitions

```text
                    add
                     │
                     ▼
   start    ┌──── pending ───┐  block    cancel
  ────────► │     ▲   ▲      │ ────────► blocked / cancelled
            │     │   │      │              │
            │     │ reopen   │ ◄─── reopen ─┘
            │     │ (any)    │
            │     │          │
            ▼  review        │
        in_progress ─────► review
            │                  │
            │ complete         │ complete
            └────────────────► completed
```

The six statuses and their glyphs:

| Status        | Glyph | Used for                                                                                                                              |
| ------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`     | `○`   | Queued; not yet started.                                                                                                              |
| `in_progress` | `→`   | Currently being worked on. At most one item.                                                                                          |
| `review`      | `⋯`   | Work is done, verification pending (e.g. tests running, awaiting CI, asking the user). At most one item.                              |
| `completed`   | `✓`   | Done and verified.                                                                                                                    |
| `blocked`     | `⛔`  | Work still needed, parked on an external dependency. Note explains what is being waited on.                                           |
| `cancelled`   | `⊘`   | Out of scope. No work will be done. Note explains why (superseded, duplicate, pivoted, no longer relevant).                           |

**Block-vs-cancel rule.** This is the distinction the system-prompt injection hammers on:

- Use `block` when work is still needed but parked on an external dependency. The note carries what is being waited on.
- Use `cancel` when the item is no longer in scope. No work will be done. The note carries why.

The glyphs reinforce this: `⛔` reads as parked / needs attention; `⊘` reads as crossed-out / closed without action.
Never silently abandon an item: either `complete`, `block`, or `cancel`.

**Invariants.**

- At most one `in_progress` and at most one `review` item at a time. WIP=1 on each is independent: you can have one item
  being worked on and one awaiting verification simultaneously.
- `complete` from `in_progress` requires a `note`; from `review` the note is optional (the review step was the
  parking). `block` and `cancel` always require a note.
- `cancel` rejects `completed` items - call `reopen` first to move them back to `pending`, then `cancel` if needed.

## Branch-aware persistence

Every successful tool call mirrors the post-action state in two places so the plan reconstructs cleanly across `/fork`,
`/tree`, and `/compact`:

1. **Tool-result details** (`toolResult.details`) - the canonical post-action state for the call, picked up by
   navigation across the branch tree.
2. **Custom session entry** (`pi.appendEntry('todo-state', state)`) - travels alongside the tool result so `/compact`
   can summarize away old tool-result messages without losing the plan.

The reducer in [`todo-reducer.ts`](../../../lib/node/pi/todo-reducer.ts) accepts either shape and picks the last valid
snapshot on the branch via `reduceBranch` (newest-to-oldest scan, `O(n)`). See
[`branch-state.ts`](../../../lib/node/pi/branch-state.ts) for the shared scaffolding it builds on.

## `/todos` overlay

Bottom-anchored read-only overlay rendered by `TodoOverlay`. Same header-rule style as the other pi overlays
(`─── Todos ───…`), with a right-aligned `done/total` chip themed `muted`. Body is:

1. A progress bar (`▰` filled / `▱` empty) sized to the terminal (8 cells at 80 cols, up to 20 at wide terminals)
   followed by the percentage chip and a count summary
   (`1 active · 1 review · 2 pending · 1 blocked · 2 cancelled` - non-zero buckets only).
2. Grouped sections in fixed order: `In progress`, `Review`, `Pending`, `Blocked`, `Cancelled (N)`, `Completed (N)`.
   Empty sections are skipped. Notes render on a continuation line prefixed `• ` so long notes stay readable.

Press `Escape` (or `Ctrl-C`) to close. No in-overlay state mutation; navigation comes later if it's useful.

## Inline `renderCall` / `renderResult`

`renderCall` emits a one-line tool card with a small `<from> → <to>` status-transition triplet:

```text
todo start #4  ○ → →
todo review #5  → → ⋯  (needs vitest)
todo complete #4  ⋯ → ✓  (tests pass; npm run tsc clean)
todo block #8  ○ → ⛔  (waiting on db review)
todo cancel #9  ○ → ⊘  (superseded by the split-into-three-plans pivot)
todo reopen #9  ✓ → ○
todo add [3 items]
todo list
```

The `<from>` glyph is the per-action default from
[`transitionGlyphs`](../../../lib/node/pi/todo-reducer.ts) rather than the live previous status, because `renderCall`
only has access to the tool args. `add` / `list` / `clear` omit the triplet entirely.

`renderResult` emits the grouped layout: header line (`N/total done  ▰▰▰▱▱▱▱▱ · …`), then each non-empty
section. Collapsed view caps the `Completed` section behind a `… N completed (Ctrl+O to expand)` hint;
`Cancelled` is uncapped in v1 because the note carries the why-it-closed reason and that signal is worth seeing.

## Environment variables

- `PI_TODO_DISABLED=1` - skip the extension entirely (no tool, no overlay, no injection, no guardrail).
- `PI_TODO_DISABLE_AUTOINJECT=1` - keep the tool but don't append the active plan to the system prompt each turn.
- `PI_TODO_DISABLE_GUARDRAIL=1` - keep the tool and the injection but don't fire the `agent_end` "you claimed done but
  items are still open" steer.
- `PI_TODO_MAX_INJECTED=N` - cap on `pending` items rendered in the injected block (default `10`, floor `1`).

## Helpers

- [`../../../lib/node/pi/todo-reducer.ts`](../../../lib/node/pi/todo-reducer.ts) - pure state model: `TodoState`,
  `TodoStatus`, `Todo`, the eight action handlers (`actAdd` / `actStart` / `actReview` / `actComplete` / `actBlock` /
  `actCancel` / `actReopen` / `actClear`), `reduceBranch`, `formatText`, `statusGlyph`, `transitionGlyphs`,
  `groupTodos`, `formatTodoProgress`, `TODO_CUSTOM_TYPE = 'todo-state'`, `TODO_TOOL_NAME = 'todo'`.
- [`../../../lib/node/pi/todo-prompt.ts`](../../../lib/node/pi/todo-prompt.ts) - `formatActivePlan(state, { maxItems })`
  renders the system-prompt block (including the block-vs-cancel rule); `looksLikeCompletionClaim(text)` is the
  heuristic the guardrail uses to detect a "done" sign-off.
- [`../../../lib/node/pi/branch-state.ts`](../../../lib/node/pi/branch-state.ts) - shared `BranchEntry` /
  `ActionResult` / `findLatestStateInBranch` scaffolding the reducer builds on.

## Companion skill

[`config/pi/skills/plan-first/SKILL.md`](../skills/plan-first/SKILL.md) teaches the model **when** to call this tool
(plan-first on any task with more than one or two steps). The extension provides the mechanism; the skill provides the
policy. The skill calls out the block-vs-cancel distinction so weaker models route obstacles correctly.

## Hot reload

Edit [`extensions/todo.ts`](./todo.ts) or any of the helpers under
[`../../../lib/node/pi/todo-*.ts`](../../../lib/node/pi/) and run `/reload` in an interactive pi session to pick up
changes without restarting. State on the current branch survives the reload (it lives in session entries, not in the
extension's in-memory mirror, which is rebuilt on `session_start` / `session_tree`).
