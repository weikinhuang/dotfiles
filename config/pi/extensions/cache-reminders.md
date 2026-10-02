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
its projected historical items. Anthropic/Bedrock cache-boundary handling remains available independently; it is not an
alternate reminder transport.

## Configuration

Stable projection is enabled by default. The former `PI_CACHE_REMINDERS_ENABLED` opt-in is removed and has no effect.
Memory no longer has a system-prompt index fallback; all framed state reminders use this lifecycle.

`PI_CACHE_REMINDERS_DISABLED=1` disables the coordinator **and suppresses its producers**, rather than restoring legacy
tail delivery. Todo, scratchpad, background jobs, the memory index/capture reminder, roleplay
lore/depth/repetition/events, and ComfyUI job reminders honor this switch. Manual state tools and their result details
remain available. Independent static persona/scene prompts and intentional context management remain separate
mechanisms.

Per-producer overrides still work: `PI_TODO_DISABLE_AUTOINJECT=1`, `PI_BG_BASH_DISABLE_AUTOINJECT=1`,
`PI_SCRATCHPAD_DISABLE_AUTOINJECT=1`, `PI_MEMORY_DISABLE_AUTOINJECT=1`, or `PI_ROLEPLAY_DISABLE_AUTOINJECT=1`.

These primary switches do not disable independent aspects: memory capture uses `PI_MEMORY_DISABLE_CAPTURE=1`; roleplay
depth/lore/repetition/events have their own switches. Do not treat the primary roleplay index switch as a complete stop
for every roleplay context transform.

## Validation and immediate escape hatches

1. Run `ai-cost-doctor pi <session-id> --no-color --no-cost` first; original transcripts remain read-only.
2. Enable hash-only tracing with `--cache-trace auto --cache-trace-level hash` when diagnosing cache behavior.
3. Start a fresh session or reload to use default stable delivery. No enable flag or legacy transport selection exists.
4. Only if useful, opt into native key isolation with `PI_CACHE_BREAKPOINT_RESPONSES_KEY=1`; pi already supplies a
   stable key. Do not add unsupported Azure/OpenAI cache fields.
5. Keep the local-only guard, or disable it with `PI_COST_GUARD_DISABLED=1`. It never changes injector state.
6. Provider billing validation remains separate from this default change. A paid smoke test still needs explicit
   approval and a hard total USD cap, preflight request/output bounds, a maximum call count, and immediate stop on
   frozen reads or budget exhaustion. Local fixture and full-stack self-hosted tests establish serialization stability;
   they do not prove Azure/OpenAI billing savings or the below-30%-write-spend target.

To stop primary auto-injection without removing tools:

```bash
export PI_TODO_DISABLE_AUTOINJECT=1
export PI_BG_BASH_DISABLE_AUTOINJECT=1
export PI_SCRATCHPAD_DISABLE_AUTOINJECT=1
export PI_MEMORY_DISABLE_AUTOINJECT=1
export PI_ROLEPLAY_DISABLE_AUTOINJECT=1
```

To suppress all managed auto-reminders, set `PI_CACHE_REMINDERS_DISABLED=1`. This also prevents producers from emitting
unsafe tails; there is no legacy fallback. Disabling delivery after snapshots were cached can invalidate the prefix
once, because historical projected items are omitted. Tracing, doctor detection, and the local guard remain independent.
Explicit persistent directives such as `PI_MEMORY_CAPTURE_TURN=1` do not use this reminder transport. Already-cached
legacy mutations cannot be repaired retroactively. No paid provider test has been run.

## Verification and hot reload

The Phase 0 fixtures reproduce divergence in the installed Azure/OpenAI Responses converter, even with a stable body.
The lifecycle fixtures test ten tool-loop requests, mid-run transitions, sorted composition, resume, branch isolation,
and compaction. These prove local serialization stability, not provider cache hits or measured savings. No paid smoke
test has been run. Use `PI_CACHE_TRACE=<path>` for content-free request diagnostics when explicitly approving one.

Editing this extension or [`reminder-lifecycle.ts`](../../../lib/node/pi/reminder-lifecycle.ts) requires `/reload`.
Already-cached legacy reminders cannot be retroactively repaired; use a fresh session for validation.
