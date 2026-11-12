# `memory`

Cross-session memory for opencode: small markdown notes about the user, their feedback, the project, and external
references, plus per-session working notes, indexed into the model's context. Ported from the pi
[`memory`](../../../pi/extensions/memory.md) extension and **sharing its store**, so a memory saved in pi is visible in
opencode and vice versa. Parts: [`server.ts`](./server.ts) (tool, index delivery, RPC handlers), [`tui.tsx`](./tui.tsx)
(`/memory` dialog), and [`rpc.ts`](./rpc.ts). Logic lives in
[`lib/node/opencode/memory.ts`](../../../../lib/node/opencode/memory.ts) and
[`memory-delivery.ts`](../../../../lib/node/opencode/memory-delivery.ts); the actions, layout, and renderers are pi's
own [`lib/node/pi/memory/actions.ts`](../../../../lib/node/pi/memory/actions.ts),
[`memory-paths.ts`](../../../../lib/node/pi/memory-paths.ts), and
[`memory-prompt.ts`](../../../../lib/node/pi/memory-prompt.ts).

## Shared store

The default root is pi's: `PI_MEMORY_ROOT`, else `<PI_CODING_AGENT_DIR or ~/.pi/agent>/memory`. The layout, the five-key
frontmatter, slugs, and the `MEMORY.md` indices are produced by the same code pi runs, so files are byte-identical (see
[the pi doc](../../../pi/extensions/memory.md#layout)). The project key is pi's cwd slug of opencode's location
directory (`/work/app` -> `projects/--work-app--`); `PI_MEMORY_PROJECT_SLUG` pins it for both hosts. Session-scope
`note`s live under the opencode session id, so pi and opencode never load each other's session notes.

Disk is the source of truth: every tool call and every index sync rescans it. New files are claimed with an exclusive
create and written atomically, so concurrent saves from pi and opencode get distinct slugs; updates of one memory are
last-writer-wins.

## Tool

`memory` is a direct tool (`codemode: false`) with pi's actions and semantics:

| Action   | Required                                    | Optional        | Purpose                                           |
| -------- | ------------------------------------------- | --------------- | ------------------------------------------------- |
| `list`   | -                                           | -               | Dump the global, project, and session indices.    |
| `read`   | `id`                                        | `type`, `scope` | Load a memory's full body.                        |
| `save`   | `type`, `name`, `description`, `body`       | `scope`         | Write a new memory and its `MEMORY.md` line.      |
| `update` | `id` + at least one of `name`/`desc`/`body` | `type`, `scope` | Rewrite fields; a rename changes the slug.        |
| `remove` | `id`, `scope`                               | `type`          | Delete a memory and drop it from `MEMORY.md`.     |
| `search` | `query`                                     | -               | Word match over name, description, body (top 10). |

Types and default scopes: `user` / `feedback` -> `global`, `project` / `reference` -> `project`, `note` -> `session`.
Errors (bad input, unknown id, read-only) fail the call with the pi message. There is no permission gate, as in pi;
secret-shaped content is caught upstream by [`secret-redactor`](../secret-redactor/README.md), which keeps real values
out of the model's view.

## Index delivery

The index reaches the model through two session instruction entries (`ctx.session.instructions.entry`):

- `memory-index`: the full `## Memory` block (pi's renderer, capped by `maxInjectedChars`, budget spent feedback -> user
  -> note -> reference -> project, with `(Nd)` markers on stale project entries).
- `memory-changes`: a `## Memory changes` delta (`+` / `~` / `-` lines) against that full block, put when the index
  changes outside this session's own tool calls (pi, another session, a hand edit). More than 12 changes, or any change
  to a capped index, re-puts the full block instead.

The `prompt` hook syncs them before the step that answers each user prompt; a compaction re-puts the full block. The
model's own writes are not re-announced (the tool result already told it). Per-session bookkeeping lives in the plugin's
`ctx.storage`, so a restart does not resend anything.

**Why instruction entries, not the `context` hook.** opencode freezes a session's instruction values into a baseline in
the system prompt (the last instruction source, so the shared prefix before it stays cacheable across sessions) and
announces later puts and removals as durable, chronological updates at the next step boundary, without a message turn. A
compaction folds the current values into a new baseline, and revert and fork are handled natively. That is exactly pi's
contract (full index once, a small delta when it changes, nothing otherwise, every earlier byte unchanged), with no
bookkeeping of our own for history positions. A `context` hook edit is per request: re-rendering the index there would
either change bytes inside the cached prefix or require persisting and replaying our own snapshot positions.

The trade-off: opencode renders a changed entry as its full new value, which is why the delta lives in its own key.

## Subagents

Subagent child sessions (`parentID` set) get neither the index nor the tool: the `context` hook drops `memory` from a
child's tool list and a call is refused. This matches pi, whose subagent children do not load the `memory` extension or
tool. Memory policy belongs to the user-facing session; children run scoped tasks and report back, and fan-out children
would otherwise each pay for the index and race on writes. Forks are not children and inherit the parent's entries.

## `/memory`

One slash and palette command opens a picker, then shows the chosen report for the current session:

- **List**: every memory in the global, project, and session scopes, plus scan warnings (malformed files).
- **Preview**: what the next prompt would put or remove, and the full rendered index.
- **Dir**: the store root, scope directories, project slug (tagged when `PI_MEMORY_PROJECT_SLUG` pins it), session id.
- **Stale**: project memories older than `staleDays`, oldest first.

## Options

Set options with a plugin entry in `opencode.jsonc` (see [Install](../README.md#install)). Every option also has an
`OPENCODE_MEMORY_*` environment override, which wins over the option. The TUI part has no options.

| Option             | Env override                         | Default   | Effect                                                  |
| ------------------ | ------------------------------------ | --------- | ------------------------------------------------------- |
| `enabled`          | `OPENCODE_MEMORY_ENABLED`            | `true`    | `false` disables the plugin.                            |
| `root`             | `OPENCODE_MEMORY_ROOT`               | pi's root | Store root (`~` expands). Point tests at a scratch dir. |
| `autoInject`       | `OPENCODE_MEMORY_AUTO_INJECT`        | `true`    | Deliver the index; `false` keeps only the tool.         |
| `readOnly`         | `OPENCODE_MEMORY_READ_ONLY`          | `false`   | Refuse `save` / `update` / `remove`.                    |
| `maxInjectedChars` | `OPENCODE_MEMORY_MAX_INJECTED_CHARS` | `6000`    | Soft cap on the full index (floor `500`).               |
| `staleDays`        | `OPENCODE_MEMORY_STALE_DAYS`         | `30`      | Age for the `(Nd)` marker and the Stale view.           |
| `debugFile`        | `OPENCODE_MEMORY_DEBUG_FILE`         | unset     | Append one JSON line per index sync (kind and ops).     |

## Not ported

- **Capture-assist** (pi's post-compaction "save what is unsaved" nudge). opencode has no one-shot model-visible channel
  that fits: an instruction entry is persistent, so clearing it is narrated to the model ("no longer applies"), and a
  `context` hook insertion vanishes from later requests and breaks the cached tail. opencode's summary sections
  (`Requirements` / `Decisions`) also differ from the ones pi mines. A `ctx.session.synthetic` turn (pi's opt-in
  `PI_MEMORY_CAPTURE_TURN`) is the likely route.
- **`/memory gc`**. The store is shared, so an orphan check needs both hosts' live session ids. Note that pi's own
  `/memory gc` prunes every session dir without a pi transcript, including opencode's (`ses_*`) session notes.
- **`memory-first` skill**. Not wired into opencode; the tool description carries the when-to-save and what-not-to-save
  rules.
- `/memory rescan` is unnecessary (every call rescans), and pi's `memory:changed` event has no counterpart.

## Limitations

- `autoInject: false` (or disabling the plugin) does not remove entries already put in existing sessions.
- The index is synced on user prompts and compactions only; a change made by pi mid-run is seen at the next prompt.
- Restart opencode after editing the `lib/node/` helpers; helper hot reload is not reliable.

## Live test

Point the store at the scratch dir; never at the real `~/.pi/agent/memory`.

```bash
S=/tmp/opencode-smoke-mem
./dev/opencode-plugin-smoke.sh start -n mem -e OPENCODE_MEMORY_ROOT=$S/memstore -e PI_MEMORY_ROOT=$S/memstore \
  -e OPENCODE_MEMORY_DEBUG_FILE=$S/memdebug.jsonl memory
./dev/opencode-plugin-smoke.sh send mem 'Use the memory tool to save a project memory named "Deploy freeze" (description "deploys frozen from 2026-12-20", body "No deploys until 2027-01-05."), then reply DONE1'
./dev/opencode-plugin-smoke.sh wait mem '^ +DONE1'
find $S/memstore -type f; cat $S/memstore/projects/*/MEMORY.md   # pi's layout and index format
./dev/opencode-plugin-smoke.sh restart mem --continue
./dev/opencode-plugin-smoke.sh send mem 'Without tools, list the memory ids in your index, then reply DONE2'
./dev/opencode-plugin-smoke.sh wait mem '^ +DONE2'
tail -3 $S/memdebug.jsonl   # full, then none (no resend after restart)
./dev/opencode-plugin-smoke.sh stop mem
```

To check cross-host visibility, write a memory with pi (or `runMemoryAction` under `PI_MEMORY_ROOT=$S/memstore`) and
send another prompt: the debug log shows a `delta` sync and the model can quote the `+` / `~` line.
