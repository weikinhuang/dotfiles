# `cache-reminders.ts`

Keep dynamic reminders in stable, branch-recoverable request items rather than rewriting historical user/tool results.

## Delivery lifecycle

The final `context_with_system` hook captures standalone blocks emitted by
[`applyContextReminder`](../../../lib/node/pi/context-reminder.ts) once per agent run. It sorts producers by stable ID,
removes their ephemeral blocks from the original messages, and projects a distinct user-role snapshot immediately after
the actual run-triggering input, before queued `nextTurn` or startup-handler guidance. Persisted session-entry IDs bind
origins and targets, so redaction, condensation, and tool-call overlays cannot change their identities. Request-local
identity stamps preserve SDK message references rather than forcing an unrelated system-prefix rebuild. Later tool-loop
calls reuse that snapshot unchanged, even when producers render different state. Tool results communicate mid-run
changes immediately. No additional model call is requested. The leading system message and tool declarations are left
untouched.

Custom-message runs, such as idle scheduled prompts and background completion nudges, use the same snapshot lifecycle.
The producer helper accepts custom tails because pi converts those messages to user messages after the `context` hooks.
This preserves reminder delivery without changing the stored custom message or adding a real user submit.

Snapshot bytes and anchors are persisted as branch-local custom data, not transient model output. On later real user
turns a new snapshot is appended; earlier ones remain byte-identical. Resume and tree navigation restore only the
selected branch. Compaction retains snapshots whose origin and targets survive; evicted origins suppress the whole
snapshot and missing targets suppress only their placements. Restore/recovery does not authorize a fresh capture.
Existing consumer reducers/disk stores remain the source of current state. Historical items stay unchanged until their
source messages leave the active context.

The capture happens at the first fully assembled context, not individually in each producer's `before_agent_start`: this
includes late roleplay/context-window transforms, depth placement metadata, and memory's compaction nudge in one
deterministic snapshot. Repeated calls in the same run cannot capture new state. Resume/retry on the same anchor retains
its old snapshot. Recovery rearming never captures against a tool-result or assistant tail; it only replays surviving
historical snapshots there.

Roleplay emits fresh lore/note/repetition/event blocks only for user-started narrative runs and `scheduled-prompt`
custom starts. Background completions and guardrail/retry notices do not advance its narrative state. Depth lore and
author notes retain configured positions resolved once against stable message anchors. Depth 0 follows the initiating
input; positive depths may precede earlier messages. Placements share the originating run's persisted snapshot metadata
and never follow the moving end of a tool loop.

## Composition

| Producer              | Snapshot content                                                   |
| --------------------- | ------------------------------------------------------------------ |
| `todo`                | Active plan only; completed plans render nothing                   |
| `bg-bash`             | Running jobs and as-yet-unsurfaced terminal jobs                   |
| `scratchpad`          | Working notes                                                      |
| `memory`              | Memory index and capture-assist nudge                              |
| `roleplay`, `comfyui` | Standalone reminder blocks emitted by their existing context hooks |

The snapshot coordinator runs after every `context` producer. Outside the coordinated final safety passes below, other
`context_with_system` extensions must not rewrite its projected historical items. Anthropic/Bedrock cache-boundary
handling remains available independently; it is not an alternate reminder transport.

## Finalization and safety

The coordinator separates preparation, preview, and commit. Relative depths retain their selected bodies while trial
windows are evaluated; only the accepted first request stores their resolved targets. Previews never persist snapshots,
consume pending capture, or acknowledge scene events. Persistence must succeed before the in-memory capture is
committed.

Synchronous event bridges keep the late passes independent of factory registration order:

- `cache-reminders:capabilities` declares required sanitizer and limiter passes.
- `cache-reminders:limit` previews full candidate requests, including historical and pending snapshots. Roleplay cuts
  whole earlier turns, retains the trigger and startup guidance, and freezes the retained boundary between overflows.
- `cache-reminders:sanitize` redacts a detached projected copy, including standalone depth messages. Original messages
  and persisted snapshot bodies stay untouched; reveal approvals intentionally change later rendered bytes.
- `cache-reminders:projected` reports final request size for usage calibration and context diagnostics.

Listeners must finish synchronously; the SDK event bus does not await them. A missing required result, failed sanitizer,
or indivisible latest turn that cannot fit the estimated budget aborts the request with a data-free context. No snapshot
is persisted and no one-shot event is consumed. Token sizing remains an estimate with output/tool slack, not exact
provider tokenization. Unrelated `context_with_system` handlers must not add content after these final safety passes.

## Configuration

Stable projection is enabled by default. The former `PI_CACHE_REMINDERS_ENABLED` opt-in is removed and has no effect.
Memory no longer has a system-prompt index fallback; all framed state reminders use this lifecycle.

`PI_CACHE_REMINDERS_DISABLED=1` disables the coordinator **and suppresses its producers**, rather than restoring legacy
tail delivery. Todo, scratchpad, background jobs, the memory index/capture reminder, roleplay
lore/notes/repetition/events, and ComfyUI job reminders honor this switch. Manual state tools and their result details
remain available. Independent static persona/scene prompts and intentional context management remain separate
mechanisms.

Per-producer overrides still work: `PI_TODO_DISABLE_AUTOINJECT=1`, `PI_BG_BASH_DISABLE_AUTOINJECT=1`,
`PI_SCRATCHPAD_DISABLE_AUTOINJECT=1`, `PI_MEMORY_DISABLE_AUTOINJECT=1`, or `PI_ROLEPLAY_DISABLE_AUTOINJECT=1`.

These primary switches do not disable independent aspects: memory capture uses `PI_MEMORY_DISABLE_CAPTURE=1`; roleplay
author notes/lore/repetition/events have their own switches. Do not treat the primary roleplay index switch as a
complete stop for every roleplay context transform.

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
and compaction. Combined runtime fixtures use the installed SDK runner, real session projection/reopen behavior, both
sanitizer registration orders, startup guidance, event-generation races, and small-window projected budgets. These prove
local serialization stability, not provider cache hits or measured savings. No paid smoke test has been run. Use
`PI_CACHE_TRACE=<path>` for content-free request diagnostics when explicitly approving one.

Editing this extension or [`reminder-lifecycle.ts`](../../../lib/node/pi/reminder-lifecycle.ts) requires `/reload`.
Already-cached legacy reminders cannot be retroactively repaired; use a fresh session for validation.
