# `bg-bash.ts`

Background shell-job tool + statusline indicator. Companion to the built-in `bash` tool: where `bash` blocks the agent
turn until the command exits, `bg_bash` spawns long-running commands off-turn and exposes a single multi-action tool the
LLM uses across subsequent turns to poll, steer, and collect output.

## What it does

Registers a single `bg_bash` tool with eight actions (`start`, `list`, `status`, `logs`, `wait`, `signal`, `stdin`,
`remove`) plus a user-facing `/bg-bash` command. Each `start` routes through the shared
[`bash/gate`](../../../lib/node/pi/bash/gate.ts) so bash-permissions allow/deny rules apply; approval prompts are
serialized through a promise-chain mutex so concurrent `start` calls don't stack up racing dialogs.

- **Spawn model.** `spawn('/bin/sh', ['-c', command], { detached: true, stdio: [stdinMode, 'pipe', 'pipe'] })`, or
  `spawn('bash', ['-c', command], …)` with `shell: "bash"` (see [Shell choice](#shell-choice)). `detached: true` makes
  the child's pid its own process-group leader, so `signal`/`remove` can `process.kill(-pid, sig)` and take children
  with it. The child is NOT `unref()`-ed - pi keeps observing until exit.
- **stdin default.** `stdio[0] = 'ignore'` (≈ `/dev/null`). Non-interactive commands that happen to read stdin (pi's own
  CLI, `cat`, `ssh` without `-n`, `grep` with no args, nested agents) see immediate EOF instead of hanging. Pass
  `interactiveStdin: true` to get `stdio[0] = 'pipe'` so the `stdin` action can feed REPLs / installers.
- **Lifecycle.** Jobs live only for the pi session. On `session_start` / `session_tree` the registry is rebuilt from the
  branch via [`reduceBranch`](../../../lib/node/pi/bg-bash-reducer.ts); ghost `running`/`signaled` entries from a dead
  runtime are pruned (`pruneUnattachableJobs`) - only `exited`/`error` stay as history. On `session_shutdown` every live
  job gets SIGTERM, `killGraceMs` grace (default 3000 ms), then SIGKILL; survivors are marked `terminated`.
- **Persistence.** Every state mutation calls `pi.appendEntry('bg-bash-state', cloneState(state))` and is also tucked
  into `toolResult.details`, so `/compact`, `/fork`, `/tree` all reconstruct the registry. `ChildProcess` / `RingBuffer`
  instances are never persisted.
- **Statusline.** `⊙ bg:N` slot via `ui.setStatus('bg-bash', …)`, cleared when no jobs are running. `uiRef` is refreshed
  on every `before_agent_start` to survive session-replacement flows.
- **Active-jobs injection (via the `context` hook).** A `## Background Jobs` block rendered by
  [`formatBackgroundJobs`](../../../lib/node/pi/bg-bash-prompt.ts) (soft cap `PI_BG_BASH_MAX_INJECTED_CHARS`,
  default 1500) is spliced as an ephemeral `<system-reminder id="bg-jobs">` into the last user/toolResult turn via
  [`applyContextReminder`](../../../lib/node/pi/context-reminder.ts), not appended to the system prompt. Pi's `context`
  output is finalized by [`cache-reminders`](./cache-reminders.md), which captures one stable snapshot per run in a
  distinct request item and preserves it across later calls. Terminal jobs are omitted from new snapshots once their
  exact completion line has appeared in a snapshot, tool result, or completion nudge; branch-local acknowledgement
  entries recover that state after resume and compaction. Manual `list` still shows the full registry. When there are no
  running or unsurfaced terminal jobs, nothing is injected. (`uiRef` / statusline are still refreshed on
  `before_agent_start`, which now does only that.)

## Live START cards (TUI only)

The original `start` result card follows its exact runtime job after the tool returns: a compact status line shows
elapsed time, bytes and exit status, with recent stdout/stderr underneath. Each stream uses the existing 200-byte
summary tail (at most three lines collapsed or eight expanded); expansion also shows pid and cwd. Signaled jobs keep
refreshing until an end time is recorded, and `outputOpen` jobs keep following late output until the pipes close.

This is a display-only projection via [`LiveToolCards`](../../../lib/node/pi/ext/live-tool-cards.ts), with one
demand-driven 500 ms refresh timer. It never rewrites returned `content` / `details`, appends session entries, sends
messages, or changes reminder/nudge delivery. Only the original row captured before execution attaches to live data.
Exported, replayed and historical rows, and all `status` / `logs` / `wait` / `list` cards, retain their recorded
snapshots. Completion freezes the original card; removing or clearing a job preserves its final UI data. Session
start/tree resets ownership, and shutdown stops refreshes before child teardown.

## Tool: `bg_bash`

| Action   | Required  | Optional                                                                                                            | Notes                                                                                                                                     |
| -------- | --------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `start`  | `command` | `cwd`, `label`, `env` (merged on top of `process.env`), `interactiveStdin` (false), `nudge` (false), `shell` (`sh`) | Routes through `bash/gate`. `cwd` accepts absolute / `~`-relative / agent-cwd-relative. `nudge` -> [Completion nudge](#completion-nudge). |
| `list`   | -         | -                                                                                                                   | Dumps the full registry via `formatState`.                                                                                                |
| `status` | `id`      | -                                                                                                                   | Single-job line. Waits for an in-flight `wait` on the same job ([Parallel batches](#parallel-tool-batches)).                              |
| `logs`   | `id`      | `stream` (`stdout`/`stderr`/`merged`, default `merged`), `tail`, `sinceCursor`, `grep`, `maxBytes` (default 32 KiB) | `grep` is a JS `RegExp` with no flags. Response is tail-preserving-truncated to `maxBytes` with a `… truncated; see logFile …` marker.    |
| `wait`   | `id`      | `timeoutMs` (default 15000)                                                                                         | Awaits `job.exited` race'd with timeout + `AbortSignal`. Returns `timedOut=true` if still running; otherwise a 20-line tail excerpt.      |
| `signal` | `id`      | `signal` (default `SIGTERM`; one of `SIGINT`/`SIGTERM`/`SIGKILL`/`SIGHUP`/`SIGQUIT`/`SIGUSR1`/`SIGUSR2`)            | `process.kill(-pid, sig)` targets the whole process group; falls back to `child.kill(sig)`. Status flips to `signaled` immediately.       |
| `stdin`  | `id`      | `text`, `eof`                                                                                                       | Errors if job was started with `interactiveStdin=false` (no writable stdin). `eof` closes stdin after writing.                            |
| `remove` | `id`      | -                                                                                                                   | Drops a terminal job from the registry (refuses live jobs via [`removeJob`](../../../lib/node/pi/bg-bash-reducer.ts)).                    |

## Completion nudge

By default `bg_bash` is pull-based: a finished job only surfaces on the next turn (the model polls `wait` / `logs`, or
the injected `## Background Jobs` block shows it). If the agent has gone idle at the prompt, nothing wakes it. Pass
`nudge: true` on `start` to close that gap - the same proactive-wake behaviour Claude Code's background bash has (it
re-invokes the agent when a background command exits).

- **Trigger.** Only when the job finishes **on its own**: [`isNudgeWorthy`](../../../lib/node/pi/bg-bash/nudge.ts)
  returns true for `exited` (any code) and runtime `error`. A `signaled` job was stopped deliberately (the agent's own
  `signal` action, or session shutdown) so whoever sent the signal already knows; `running` / `terminated` never nudge.
- **Delivered outcomes suppress redundant wakeups.** Terminal `status`, `wait`, `logs`, and `list` results, captured
  reminders, and committed completion digests acknowledge only canonical job summaries actually present in their
  model-facing text. Matching uses the immutable delivered snapshot, so late output changing byte counts does not undo
  acknowledgement. Hidden registry metadata, running logs, timed-out waits, and user-only live cards never count.
- **Active waits defer, not discard.** The `WaitBarrier` holds a completion while a wait is active. The delivered
  terminal wait result acknowledges it; cancellation or a failed delivery leaves it pending rather than silently losing
  the notification. Wait timeouts and abort listeners are removed when the wait settles.
- **Busy-run batching.** Pending job identities stay inside the extension rather than entering pi's follow-up queue. At
  a completed `agent_before_settle` boundary, fresh unacknowledged outcomes form one `bg-bash-nudge` custom-message
  draft and request one continuation. Other extensions' drafts are preserved. Returning a draft is not delivery: the
  extension confirms its committed session entry before acknowledging it.
- **Idle wakeup.** A 250 ms coalescer groups nearby completions, then rechecks pending outcomes, active waits, and
  `ctx.isIdle()` before using `triggerTurn`. If a user run has started, delivery stays pending for its boundary; no
  stale follow-up is queued. A custom message reaches the model without polluting editor input history.
- **Failure and abort handling.** Pending outcomes survive failed delivery. An idle send has a bounded confirmation
  check and at most one automatic retry; repeated failure produces a local warning rather than a retry loop. Aborted or
  failed runs suspend automatic wakeups until subsequent genuine user input. Committed digests remain acknowledged even
  if their continuation is aborted, preventing duplicate notices.
- **Removal and lifecycle.** Remove/clear discard matching pending identities. Shutdown and tree navigation cancel old
  timers and delivery attempts before rebuilding state; generation guards prevent late output from an old branch
  resurrecting jobs or sending stale completions. Shutdown-induced exits never nudge.
- **Rendering.** A `registerMessageRenderer('bg-bash-nudge', …)` paints a compact `⊙ bg …` card (one line per finished
  job when expanded) instead of echoing the notice text back to the user.

The flag defaults off (opt-in per call); set `nudge: true` in `bg-bash.json` to default it on for a project, or
`PI_BG_BASH_DISABLE_NUDGE=1` to turn the feature off entirely (the param/config are then ignored; jobs still run and
still surface via the active-jobs block).

## Job completion and output draining

A job is **finalized** (status flips to `exited` / `signaled`, `wait` returns, a completion becomes eligible, the
summary byte counts are frozen into the persisted snapshot) by [`attachJobIo`](../../../lib/node/pi/bg-bash-job-io.ts),
never on the child's bare `'exit'` event:

- `'exit'` only records the exit code / signal (and the wall-clock end shown as the duration). Node emits it as soon as
  the shell is reaped, which can be before its pipes are drained, and a backgrounded grandchild (`cmd &`, `npx` ->
  `node` -> workers) can keep writing to the inherited pipe after the shell is gone.
- `'close'` (every stdio stream closed) finalizes the job, after flushing the streaming decoders.
- If the pipes are still open `drainMs` (default 2000) after `'exit'`, the job finalizes anyway with `outputOpen: true`;
  job lines then end with `(output pipe still held open by a background process)`. Later bytes still land in the ring
  buffers and the log file, and the byte counts keep updating; the flag clears when the pipes close.
- The on-disk log is closed on `'close'` (or at `session_shutdown`), so late output is never written after `end()`.

The byte counts in a job line (`exited 0 after 13s, 356B`) and the `logs` header (`N bytes total`) both come from the
same ring-buffer counters, so at any moment they agree. A `logs` call on a still-running job says
`(job still running - output so far)` in its header so a partial snapshot is never mistaken for the full output.
Completed logs also include the canonical exit summary, including when only the on-disk log is available. If an exited
job still has an inherited output pipe open, the logs explicitly distinguish a finished process from partial output.
Nonzero exits use `✗` consistently in summaries, notifications, reminders, and live cards.

## Parallel tool batches

pi runs the tool calls of one assistant message in parallel: each `execute()` starts in message order, they run
concurrently, and the results are appended in message order. Before this was handled, a batch like
`[wait <id>, logs <id>]` ran `logs` immediately (a snapshot of the running job) while its result appeared after the
`wait` result reporting the exit - which looked like lost output.

`wait` now registers in a [`WaitBarrier`](../../../lib/node/pi/bg-bash/wait-barrier.ts) synchronously at execute entry,
and `logs` / `status` on the same job await any in-flight `wait` first, so they report the post-wait state in the order
the model wrote. The same counts suppress the completion nudge while a `wait` is in flight. The barrier only covers
`bg_bash` siblings: another tool in the same batch (e.g. `read` of a file the job writes) still runs concurrently with
the `wait`, so the tool description tells the model to issue it in a later turn.

## Shell choice

`start` runs `command` under `/bin/sh -c` by default: dash on Debian / Ubuntu, POSIX-mode bash 3.2 on macOS. Bash-only
syntax (`${PIPESTATUS[0]}`, `[[ ]]`, `<(…)`, arrays, `&>`, `{1..5}`, `source`) fails or misbehaves there depending on
the host.

- Pass `shell: "bash"` (or set `"shell": "bash"` in `bg-bash.json`) to spawn `bash -c` (resolved on `PATH`; a missing
  bash surfaces as a spawn error).
- When a `sh` command looks bash-only, the `start` result adds a `Warning: the command looks bash-only (…)` line
  ([`bashOnlySyntaxWarning`](../../../lib/node/pi/bg-bash/shell.ts), a small regex heuristic that can also fire on
  quoted text). It never blocks the job.
- Sandbox-wrapped commands skip the warning: the [`sandbox`](./sandbox.md) wrapper already runs the inner command under
  bash (ASRT's default shell).

## Log buffering

- Per-job [`RingBuffer`](../../../lib/node/pi/bg-bash-ring.ts) for each of stdout and stderr, default 1 MiB each
  (`PI_BG_BASH_MAX_BUFFER_BYTES`). Both streams are also tee'd to an on-disk log file under `$PI_BG_BASH_LOG_DIR`
  (default `$TMPDIR/pi-bg-bash/<pid>-<ts>`; falls back to `$HOME/.pi/bg-bash/…` if tmp is unwritable). Disk log
  interleaves in wall-clock order; memory does not.
- `sinceCursor` is an opaque byte cursor returned from a prior `logs` call. When the cursor has been evicted out of the
  ring buffer, the response sets `droppedBefore=true` and tells the model to fall back to `logFile`. For
  `stream: 'merged'`, cursor/total/dropped are the sum of both streams (approximate - exact resumable reads need a
  single stream).
- `tail: N` returns the last N lines (line-aware over `\n`, preserves trailing newline). `grep` filters line-by-line. A
  `TAIL_PREVIEW_BYTES = 200` preview is kept on `JobSummary.stdoutTail` / `stderrTail` for the injected prompt block.
- Decoders are streaming `TextDecoder`s so mid-codepoint boundaries don't corrupt output; each is flushed when its
  stream ends (or on `'close'`), never on bare `'exit'`.

## Signals and process group

Children are spawned with `detached: true`, making the pid the pgid. `signal`/`remove`/shutdown target
`process.kill(-pid, sig)` so shell children (`npm run dev` → node → webpack, etc.) die with the shell. If PG-signal
fails (e.g. already-reaped leader), falls back to `child.kill(sig)`. Default signal is `SIGTERM`. On `session_shutdown`
every live job gets SIGTERM, then up to `killGraceMs` to exit, then SIGKILL; surviving summaries are marked `terminated`
via `markLiveJobsTerminated` so the next runtime sees them as historical rather than running.

## Commands

- `/bg-bash` or `/bg-bash list` - open the bottom-anchored overlay. Top section is a structured job list (id · status
  glyph · phrase · duration · bytes · cmd); bottom section is the merged log tail for the highlighted job. Both sections
  are bounded to the terminal height: the job list is windowed (with `↑ N more` / `↓ N more` indicators, keeping the
  highlighted job in view) above the pinned log-tail block, and the tail's visible-line budget (default 8) shrinks on
  short terminals so the job list always keeps a few rows. Follow mode is default-on for running jobs; a 500 ms tick
  re-reads the in-memory ring buffer. Without a UI surface (`ctx.hasUI === false`) the command falls back to a
  `formatState` notify so headless calls still print something useful.
- `/bg-bash logs <id>` - dump in-memory stdout + stderr for a live job.
- `/bg-bash kill <id> [signal]` - signal a live job (default `SIGTERM`).
- `/bg-bash clear` - drop terminal jobs, their pending notifications, and closed-job buffers. Finalized signaled jobs
  are terminal; jobs still awaiting exit are untouched. Removed jobs with inherited output pipes keep draining to their
  disk log until close, without reappearing in the registry. Shutdown closes any remaining locally owned pipes.

### Overlay keybindings

- `↑` / `↓` (or `Ctrl+P` / `Ctrl+N`) -- move the selection.
- `f` -- toggle freeze on the highlighted job's tail. Follow defaults to on for running jobs; freezing lets you read
  scrollback without the tail scrolling out from under you. The mid-rule chip drops the `follow` marker when frozen.
- `k` / `K` -- send `SIGTERM` / `SIGKILL` to the highlighted job. Routed through the same `actSignal` helper used by the
  `bg_bash` tool, so the registry stays consistent across surfaces.
- `r` -- remove the highlighted job from the registry (terminal jobs only). Routes through `actRemove`.
- `c` -- clear every terminal job from the registry (live jobs untouched). Shares its implementation with the
  `/bg-bash clear` sub-verb.
- `Escape` (or `Ctrl+C`) -- close the overlay.

## Environment variables

- `PI_BG_BASH_DISABLED=1` - skip the extension entirely.
- `PI_CACHE_REMINDERS_DISABLED=1` - suppress managed job reminders globally, without changing manual tools or
  independently configured completion nudges. No legacy tail transport is restored.
- `PI_BG_BASH_DISABLE_AUTOINJECT=1` - keep the tool but don't inject `## Background Jobs` (disables the `context`-hook
  injection; the tool, statusline, and overlay still work).
- `PI_BG_BASH_DISABLE_NUDGE=1` - disable the [completion nudge](#completion-nudge) feature entirely; the `nudge` param /
  config are ignored.
- `PI_BG_BASH_MAX_INJECTED_CHARS=N` - soft cap on the injected block (default `1500`, floor `200`).
- `PI_BG_BASH_MAX_BUFFER_BYTES=N` - per-stream ring-buffer cap (default `1048576`, floor `0`).
- `PI_BG_BASH_KILL_GRACE_MS=N` - SIGTERM→SIGKILL grace window on shutdown (default `3000`, floor `0`).
- `PI_BG_BASH_DRAIN_MS=N` - max ms to keep draining stdout/stderr after the shell exits before finalizing the job
  (default `2000`, floor `0`). See [Job completion](#job-completion-and-output-draining).
- `PI_BG_BASH_LOG_DIR=…` - override log directory root (default `$TMPDIR/pi-bg-bash`).

## Config file

Optional `bg-bash.json` config layers let a project pin per-call tool-param defaults and the operational knobs that were
previously env-only. Layers, lowest precedence first: built-in defaults → `PI_BG_BASH_*` env knobs → user
`~/.pi/agent/bg-bash.json` → project `<cwd>/.pi/bg-bash.json`. A per-call tool param always wins over the config, so the
full resolution order is:

```text
per-call param > project config > user config > env knob > built-in default
```

(Pure logic in [`../../../lib/node/pi/bg-bash/config.ts`](../../../lib/node/pi/bg-bash/config.ts); the shell only does
`params.X ?? config.X`.)

| Key                | Type                             | Default   | Effect                                                                  |
| ------------------ | -------------------------------- | --------- | ----------------------------------------------------------------------- |
| `timeoutMs`        | integer ≥ 0                      | `15000`   | Default `wait` timeout when a call omits `timeoutMs`.                   |
| `stream`           | `stdout` \| `stderr` \| `merged` | `merged`  | Default `logs` stream when a call omits `stream`.                       |
| `maxBytes`         | integer ≥ 1                      | `32768`   | Default soft cap on `logs` response bytes when a call omits `maxBytes`. |
| `tail`             | integer ≥ 0                      | (unset)   | Default `logs` tail-line count; unset = return the whole buffer.        |
| `maxBufferBytes`   | integer ≥ 0                      | `1048576` | Per-stream ring-buffer cap (env: `PI_BG_BASH_MAX_BUFFER_BYTES`).        |
| `killGraceMs`      | integer ≥ 0                      | `3000`    | SIGTERM→SIGKILL grace on shutdown (env: `PI_BG_BASH_KILL_GRACE_MS`).    |
| `drainMs`          | integer ≥ 0                      | `2000`    | Post-exit stdio drain deadline (env: `PI_BG_BASH_DRAIN_MS`).            |
| `shell`            | `sh` \| `bash`                   | `sh`      | Default `start` [shell](#shell-choice) when a call omits `shell`.       |
| `maxInjectedChars` | integer ≥ 200                    | `1500`    | Injected-block soft cap (env: `PI_BG_BASH_MAX_INJECTED_CHARS`).         |
| `nudge`            | boolean                          | `false`   | Default `start` [completion-nudge](#completion-nudge) flag.             |

```jsonc
// <cwd>/.pi/bg-bash.json - this project's builds are slow; wait longer and tail logs by default
{
  "timeoutMs": 60000,
  "tail": 40,
}
```

## Helpers

- [`../../../lib/node/pi/bg-bash-reducer.ts`](../../../lib/node/pi/bg-bash-reducer.ts) - pure state model:
  `BgBashState`, `JobSummary`, `JobStatus`, `allocateId`, `upsertJob`, `removeJob`, `findJob`, `reduceBranch`,
  `markLiveJobsTerminated`, `pruneUnattachableJobs`, `formatState` / `formatJobLine` / `statusIcon`,
  `BG_BASH_CUSTOM_TYPE = 'bg-bash-state'`.
- [`../../../lib/node/pi/bg-bash-ring.ts`](../../../lib/node/pi/bg-bash-ring.ts) - `RingBuffer` with byte-cursor
  resumable `read({ sinceCursor, maxBytes })`, `tailPreview(n)`, `byteLengthTotal` / `byteLengthDropped`.
- [`../../../lib/node/pi/bg-bash-stream.ts`](../../../lib/node/pi/bg-bash-stream.ts) - stdout/stderr/merged read
  semantics shared by `logs`, `wait`, and the overlay.
- [`../../../lib/node/pi/bg-bash-job-io.ts`](../../../lib/node/pi/bg-bash-job-io.ts) - `attachJobIo`: decoding, ring +
  log writes, and the exit / close / drain-deadline finalize ordering.
- [`../../../lib/node/pi/bg-bash/wait-barrier.ts`](../../../lib/node/pi/bg-bash/wait-barrier.ts) - `WaitBarrier` for
  in-flight `wait`s ([Parallel batches](#parallel-tool-batches), nudge suppression).
- [`../../../lib/node/pi/bg-bash/shell.ts`](../../../lib/node/pi/bg-bash/shell.ts) - `shellSpawnArgs`,
  `detectBashOnlySyntax`, `bashOnlySyntaxWarning`.
- [`../../../lib/node/pi/bg-bash-prompt.ts`](../../../lib/node/pi/bg-bash-prompt.ts) -
  `formatBackgroundJobs(state, { maxChars, now })` renders the active-jobs block (injected via the `context` hook).
- [`../../../lib/node/pi/bg-bash/completions.ts`](../../../lib/node/pi/bg-bash/completions.ts) - pending completion
  identities and acknowledgement from delivered immutable summaries.
- [`../../../lib/node/pi/bg-bash/nudge.ts`](../../../lib/node/pi/bg-bash/nudge.ts) - `isNudgeWorthy(status)`,
  `formatBgBashNudge(jobs, now)`, and `BG_BASH_NUDGE_CUSTOM_TYPE` for the [completion nudge](#completion-nudge).
- [`../../../lib/node/pi/bash/gate.ts`](../../../lib/node/pi/bash/gate.ts) - `requestBashApproval`, shared with the
  built-in `bash` tool.
- [`../../../lib/node/pi/sandbox/wrapper-slot.ts`](../../../lib/node/pi/sandbox/wrapper-slot.ts) - `requestSandboxWrap`,
  the slot the [`sandbox`](./sandbox.md) extension fills with its `srt`/`sandbox-exec`/`bwrap` wrapper. `bg_bash start`
  calls it after `requestBashApproval` so the spawned shell child runs under the kernel sandbox too. When no wrapper is
  installed (sandbox extension disabled, missing deps, unsupported platform) the helper identity-wraps and `bg_bash`
  keeps working unchanged. The Phase 0 kill-tree spike verified that `process.kill(-pid, sig)` reaps through both
  `sandbox-exec` (macOS) and `bwrap` (Linux), so no extra signal plumbing is needed.

## Hot reload

Edit [`extensions/bg-bash.ts`](./bg-bash.ts) or any of the helpers under `../../../lib/node/pi/bg-bash-*.ts` /
`../../../lib/node/pi/bg-bash/*.ts` / [`bash/gate.ts`](../../../lib/node/pi/bash/gate.ts) and run `/reload` in an
interactive pi session to pick up changes without restarting. Live jobs from the previous runtime survive the module
reload (the `ChildProcess` handles are held by closures that get replaced) - prefer restarting pi if you need to
re-attach cleanly.
