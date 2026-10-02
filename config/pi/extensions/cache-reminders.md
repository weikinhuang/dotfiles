# `cache-reminders.ts`

Keep dynamic reminders in stable, branch-recoverable request items rather than rewriting historical user/tool results.

## Delivery lifecycle

The final `context_with_system` hook captures standalone blocks emitted by
[`applyContextReminder`](../../../lib/node/pi/context-reminder.ts) once per agent run. It sorts producers by stable ID,
removes their ephemeral blocks from the original messages, and projects a distinct user-role snapshot immediately after
the original tail. Its anchor is a SHA-256 of the unmodified tail message. Later tool-loop calls reuse that snapshot
unchanged, even when producers render different state. Tool results communicate mid-run changes immediately. No
additional model call is requested. The leading system message and tool declarations are left untouched.

Snapshot bytes and anchors are persisted as branch-local custom data, not transient model output. On later real user
turns a new snapshot is appended; earlier ones remain byte-identical. Resume and tree navigation restore only the
selected branch. Compaction refreshes once; snapshots whose anchors were removed are not reintroduced. Existing consumer
reducers/disk stores remain the source of current state. This deliberately retains small historical snapshots until
compaction rather than removing or editing them and invalidating the prefix.

The capture happens at the first fully assembled context, not individually in each producer's `before_agent_start`: this
includes late roleplay/context-window transforms and memory's compaction nudge in one deterministic snapshot. Repeated
calls in the same run cannot capture new state. Resume/retry on the same anchor retains its old snapshot.

## Composition

| Producer              | Snapshot content                                                   |
| --------------------- | ------------------------------------------------------------------ |
| `todo`                | Active plan only; completed plans render nothing                   |
| `bg-bash`             | Running jobs and as-yet-unsurfaced terminal jobs                   |
| `scratchpad`          | Working notes                                                      |
| `memory`              | Memory index and capture-assist nudge                              |
| `roleplay`, `comfyui` | Standalone reminder blocks emitted by their existing context hooks |

The snapshot coordinator runs after every `context` producer. Other `context_with_system` extensions must not rewrite
its projected historical items. The legacy Anthropic/Bedrock cache-breakpoint helper remains available independently.

## Configuration

`PI_CACHE_REMINDERS_DISABLED=1` disables this coordinator and restores legacy ephemeral delivery, which can cause
historical-prefix divergence. Prefer disabling individual producers instead: `PI_TODO_DISABLE_AUTOINJECT=1`,
`PI_BG_BASH_DISABLE_AUTOINJECT=1`, `PI_SCRATCHPAD_DISABLE_AUTOINJECT=1`, `PI_MEMORY_DISABLE_AUTOINJECT=1`, or
`PI_ROLEPLAY_DISABLE_AUTOINJECT=1`. Manual state tools and their result details remain available.

## Verification and hot reload

The Phase 0 fixtures reproduce divergence in the installed Azure/OpenAI Responses converter, even with a stable body.
The lifecycle fixtures test ten tool-loop requests, mid-run transitions, sorted composition, resume, branch isolation,
and compaction. These prove local serialization stability, not provider cache hits or measured savings. No paid smoke
test has been run. Use `PI_CACHE_TRACE=<path>` for content-free request diagnostics when explicitly approving one.

Editing this extension or [`reminder-lifecycle.ts`](../../../lib/node/pi/reminder-lifecycle.ts) requires `/reload`.
Already-cached legacy reminders cannot be retroactively repaired; use a fresh session for validation.
