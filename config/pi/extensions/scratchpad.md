# `scratchpad.ts`

Unstructured working-notes tool + system-prompt auto-injection. Companion to [`todo.ts`](./todo.md): where `todo` holds
the typed plan (pending / in_progress / review / completed / blocked), `scratchpad` holds free-form carry-over the model
benefits from remembering turn to turn — decisions, file paths it keeps rediscovering, test / lint commands, user
answers to clarifying questions.

## What the tool does

Registers a single `scratchpad` tool the LLM can call and a `/scratchpad` command for the user. Actions:

| Action   | Required                     | Optional                | Purpose                                                                                |
| -------- | ---------------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `list`   | —                            | —                       | Dump the current notebook.                                                             |
| `append` | `body`                       | `heading`               | Add a note. `heading` groups related notes in the injected block.                      |
| `update` | `id` (+ `body` or `heading`) | `body` and/or `heading` | Modify a note’s body and/or heading. Empty heading clears it.                          |
| `remove` | `id`                         | —                       | Delete a note. `nextId` does **not** rewind — prevents id collisions on later appends. |
| `clear`  | —                            | —                       | Wipe the notebook.                                                                     |

Notes are trimmed on write; attempting to `update` a note with an empty body returns an error (pointing at `remove`).

## Weak-model affordances

1. **System-prompt auto-injection** (`before_agent_start`). The notebook is rendered under a `## Working Notes` header
   with a soft character cap (default 2000) so long sessions don’t eat the prompt. Notes are grouped by heading in
   first-seen order; ungrouped notes render first under an implicit “Notes” header. When the cap is hit we emit a
   trailer telling the model to call `scratchpad` with action `list` for the rest.

2. **Compaction resilience.** Each successful tool call mirrors the post-action state to a
   `customType: 'scratchpad-state'` session entry in addition to `toolResult.details`. Pi’s `/compact` can summarize old
   tool-result messages away; the custom entry travels with the branch so the reducer in
   [`lib/node/pi/scratchpad-reducer.ts`](../../../lib/node/pi/scratchpad-reducer.ts) can still reconstruct the notebook
   on `session_start` / `session_tree`.

3. **Branch awareness.** Because state is reconstructed from the branch, `/fork`, `/tree`, and `/clone` automatically
   show the correct notes for that point in history. No external files, no cross-branch leakage.

## Commands

- `/scratchpad` (or `/scratchpad list`) — raw state dump of every note id / heading / body on the current branch.
- `/scratchpad preview` — shows the exact `## Working Notes` block that would be appended to the next turn's system
  prompt (respecting `PI_SCRATCHPAD_MAX_INJECTED_CHARS`). Surfaces a clear "nothing would be injected" message when the
  notebook is empty or `PI_SCRATCHPAD_DISABLE_AUTOINJECT=1` is set, so you can quickly answer "is the extension doing
  anything this turn?" without reading extension code.

## Environment variables

- `PI_SCRATCHPAD_DISABLED=1` — skip the extension entirely.
- `PI_SCRATCHPAD_DISABLE_AUTOINJECT=1` — keep the tool but don’t append the notebook to the system prompt.
- `PI_SCRATCHPAD_MAX_INJECTED_CHARS=N` — soft cap on the injected block in characters (default `2000`, floor `200`).

## Hot reload

Edit [`extensions/scratchpad.ts`](./scratchpad.ts) or the helpers under
[`lib/node/pi/scratchpad-reducer.ts`](../../../lib/node/pi/scratchpad-reducer.ts) /
[`lib/node/pi/scratchpad-prompt.ts`](../../../lib/node/pi/scratchpad-prompt.ts) and run `/reload` in an interactive pi
session to pick up changes without restarting.
