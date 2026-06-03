# `message-edit.ts`

Edit a user or assistant message **in place for steering** (OpenWebUI-style), without dropping any downstream turns. One
of three extensions on the shared context-edit core ([`lib/node/pi/context-edit/`](../../../lib/node/pi/context-edit));
siblings are [`context-trim.ts`](./context-trim.md) (remove bulky content) and [`tool-collapse.ts`](./tool-collapse.md)
(collapse a tool call and its result). See [`context-trim.md`](./context-trim.md) for the shared non-destructive overlay
model.

## Why an overlay, and what that means

Pi's session is append-only: the only way to rewrite recorded history is to branch from an earlier entry, which
**deletes every turn after it**. That is the wrong behavior for steering a message in the middle of a long conversation.
So this extension overlays the edit in the `context` hook instead:

- The original message stays in the session `.jsonl`. Every later turn is preserved.
- The edit is reapplied each turn and rebuilt from a persisted `custom` entry on `session_start`, so it **survives
  `/reload` and exit then resume**.
- It is therefore _persistent steering_, not a one-shot. The edited text keeps being sent until you `restore` it.
- Only assistant `text` is editable, not `thinking` blocks.

This is the honest form of "editing the assistant's message": you are changing what the model sees going forward, not
pretending the past was different. The transcript on disk still records what was actually said.

## Commands

- `/context-edit` - list editable user/assistant messages with a snippet and a handle (`msg2`).
- `/context-edit <handle>` - open an editor prefilled with that message's current text; submit to store the edit, which
  applies from the next turn. Cancelling or submitting an unchanged buffer is a no-op. **The message handles also appear
  in the argument autocomplete menu** (each annotated with a snippet), so you can pick the message to edit directly.
- `/context-edit list` - show active edits by directive `#id`.
- `/context-edit restore <#id>` - undo one edit (the original message is sent again).
- `/context-edit clear` - undo all edits.
- `/context-edit help` (or `--help` / `-h` / `?`) - print usage.

Editing requires an interactive UI (the prefilled editor); in print / RPC modes the command reports that and does
nothing.

## Environment variables

- `PI_MESSAGE_EDIT_DISABLED=1` - skip the extension entirely.

## Hot reload

Edit [`extensions/message-edit.ts`](./message-edit.ts) or the core under
[`lib/node/pi/context-edit/`](../../../lib/node/pi/context-edit) and run `/reload` in an interactive pi session.
