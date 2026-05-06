# `bg-bash.ts`

Background shell-job tool + statusline indicator. Companion to the built-in `bash` tool: where `bash` blocks the agent
turn until the command exits, `bg_bash` spawns long-running commands off-turn and exposes a single multi-action tool the
LLM uses across subsequent turns to poll, steer, and collect output.

## What it does

Registers a single `bg_bash` tool with eight actions (`start`, `list`, `status`, `logs`, `wait`, `signal`, `stdin`,
`remove`) plus a user-facing `/bg-bash` command. Each `start` routes through the shared
[`bash-gate`](../../../lib/node/pi/bash-gate.ts) so bash-permissions allow/deny rules apply; approval prompts are
serialized through a promise-chain mutex so concurrent `start` calls don't stack up racing dialogs.

- **Spawn model.** `spawn('/bin/sh', ['-c', command], { detached: true, stdio: [stdinMode, 'pipe', 'pipe'] })`.
  `detached: true` makes the child's pid its own process-group leader, so `signal`/`remove` can
  `process.kill(-pid, sig)` and take children with it. The child is NOT `unref()`-ed — pi keeps observing until exit.
- **stdin default.** `stdio[0] = 'ignore'` (≈ `/dev/null`). Non-interactive commands that happen to read stdin (pi's own
  CLI, `cat`, `ssh` without `-n`, `grep` with no args, nested agents) see immediate EOF instead of hanging. Pass
  `interactiveStdin: true` to get `stdio[0] = 'pipe'` so the `stdin` action can feed REPLs / installers.
- **Lifecycle.** Jobs live only for the pi session. On `session_start` / `session_tree` the registry is rebuilt from the
  branch via [`reduceBranch`](../../../lib/node/pi/bg-bash-reducer.ts); ghost `running`/`signaled` entries from a dead
  runtime are pruned (`pruneUnattachableJobs`) — only `exited`/`error` stay as history. On `session_shutdown` every live
  job gets SIGTERM, `killGraceMs` grace (default 3000 ms), then SIGKILL; survivors are marked `terminated`.
- **Persistence.** Every state mutation calls `pi.appendEntry('bg-bash-state', cloneState(state))` and is also tucked
  into `toolResult.details`, so `/compact`, `/fork`, `/tree` all reconstruct the registry. `ChildProcess` / `RingBuffer`
  instances are never persisted.
- **Statusline.** `⊙ bg:N` slot via `ui.setStatus('bg-bash', …)`, cleared when no jobs are running. `uiRef` is refreshed
  on every `before_agent_start` to survive session-replacement flows.
- **System-prompt injection.** `before_agent_start` appends a `## Background Jobs` block rendered by
  [`formatBackgroundJobs`](../../../lib/node/pi/bg-bash-prompt.ts) (soft cap `PI_BG_BASH_MAX_INJECTED_CHARS`, default
  1500).

## Tool: `bg_bash`

| Action   | Required  | Optional                                                                                                            | Notes                                                                                                                                  |
| -------- | --------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `start`  | `command` | `cwd`, `label`, `env` (merged on top of `process.env`), `interactiveStdin` (false)                                  | Routes through `bash-gate`. `cwd` accepts absolute / `~`-relative / agent-cwd-relative.                                                |
| `list`   | —         | —                                                                                                                   | Dumps the full registry via `formatState`.                                                                                             |
| `status` | `id`      | —                                                                                                                   | Single-job line.                                                                                                                       |
| `logs`   | `id`      | `stream` (`stdout`/`stderr`/`merged`, default `merged`), `tail`, `sinceCursor`, `grep`, `maxBytes` (default 32 KiB) | `grep` is a JS `RegExp` with no flags. Response is tail-preserving-truncated to `maxBytes` with a `… truncated; see logFile …` marker. |
| `wait`   | `id`      | `timeoutMs` (default 15000)                                                                                         | Awaits `job.exited` race'd with timeout + `AbortSignal`. Returns `timedOut=true` if still running; otherwise a 20-line tail excerpt.   |
| `signal` | `id`      | `signal` (default `SIGTERM`; one of `SIGINT`/`SIGTERM`/`SIGKILL`/`SIGHUP`/`SIGQUIT`/`SIGUSR1`/`SIGUSR2`)            | `process.kill(-pid, sig)` targets the whole process group; falls back to `child.kill(sig)`. Status flips to `signaled` immediately.    |
| `stdin`  | `id`      | `text`, `eof`                                                                                                       | Errors if job was started with `interactiveStdin=false` (no writable stdin). `eof` closes stdin after writing.                         |
| `remove` | `id`      | —                                                                                                                   | Drops a terminal job from the registry (refuses live jobs via [`removeJob`](../../../lib/node/pi/bg-bash-reducer.ts)).                 |

## Log buffering

- Per-job [`RingBuffer`](../../../lib/node/pi/bg-bash-ring.ts) for each of stdout and stderr, default 1 MiB each
  (`PI_BG_BASH_MAX_BUFFER_BYTES`). Both streams are also tee'd to an on-disk log file under `$PI_BG_BASH_LOG_DIR`
  (default `$TMPDIR/pi-bg-bash/<pid>-<ts>`; falls back to `$HOME/.pi/bg-bash/…` if tmp is unwritable). Disk log
  interleaves in wall-clock order; memory does not.
- `sinceCursor` is an opaque byte cursor returned from a prior `logs` call. When the cursor has been evicted out of the
  ring buffer, the response sets `droppedBefore=true` and tells the model to fall back to `logFile`. For
  `stream: 'merged'`, cursor/total/dropped are the sum of both streams (approximate — exact resumable reads need a
  single stream).
- `tail: N` returns the last N lines (line-aware over `\n`, preserves trailing newline). `grep` filters line-by-line. A
  `TAIL_PREVIEW_BYTES = 200` preview is kept on `JobSummary.stdoutTail` / `stderrTail` for the injected prompt block.
- Decoders are streaming `TextDecoder`s so mid-codepoint boundaries don't corrupt output; final `decode()` on `exit`
  flushes the trailing partial.

## Signals and process group

Children are spawned with `detached: true`, making the pid the pgid. `signal`/`remove`/shutdown target
`process.kill(-pid, sig)` so shell children (`npm run dev` → node → webpack, etc.) die with the shell. If PG-signal
fails (e.g. already-reaped leader), falls back to `child.kill(sig)`. Default signal is `SIGTERM`. On `session_shutdown`
every live job gets SIGTERM, then up to `killGraceMs` to exit, then SIGKILL; surviving summaries are marked `terminated`
via `markLiveJobsTerminated` so the next runtime sees them as historical rather than running.

## Commands

- `/bg-bash [list]` — notify with `formatState`.
- `/bg-bash logs <id>` — dump in-memory stdout + stderr for a live job.
- `/bg-bash kill <id> [signal]` — signal a live job (default `SIGTERM`).
- `/bg-bash clear` — drop terminal jobs from the registry; live jobs untouched.

## Environment variables

- `PI_BG_BASH_DISABLED=1` — skip the extension entirely.
- `PI_BG_BASH_DISABLE_AUTOINJECT=1` — keep the tool but don't append `## Background Jobs` to the system prompt
  (statusline still updates).
- `PI_BG_BASH_MAX_INJECTED_CHARS=N` — soft cap on the injected block (default `1500`, floor `200`).
- `PI_BG_BASH_MAX_BUFFER_BYTES=N` — per-stream ring-buffer cap (default `1048576`, floor `0`).
- `PI_BG_BASH_KILL_GRACE_MS=N` — SIGTERM→SIGKILL grace window on shutdown (default `3000`, floor `0`).
- `PI_BG_BASH_LOG_DIR=…` — override log directory root (default `$TMPDIR/pi-bg-bash`).

## Helpers

- [`../../../lib/node/pi/bg-bash-reducer.ts`](../../../lib/node/pi/bg-bash-reducer.ts) — pure state model:
  `BgBashState`, `JobSummary`, `JobStatus`, `allocateId`, `upsertJob`, `removeJob`, `findJob`, `reduceBranch`,
  `markLiveJobsTerminated`, `pruneUnattachableJobs`, `formatState` / `formatJobLine` / `statusIcon`,
  `BG_BASH_CUSTOM_TYPE = 'bg-bash-state'`.
- [`../../../lib/node/pi/bg-bash-ring.ts`](../../../lib/node/pi/bg-bash-ring.ts) — `RingBuffer` with byte-cursor
  resumable `read({ sinceCursor, maxBytes })`, `tailPreview(n)`, `byteLengthTotal` / `byteLengthDropped`.
- [`../../../lib/node/pi/bg-bash-prompt.ts`](../../../lib/node/pi/bg-bash-prompt.ts) —
  `formatBackgroundJobs(state, { maxChars, now })` renders the system-prompt block.
- [`../../../lib/node/pi/bash-gate.ts`](../../../lib/node/pi/bash-gate.ts) — `requestBashApproval`, shared with the
  built-in `bash` tool.

## Hot reload

Edit [`extensions/bg-bash.ts`](./bg-bash.ts) or any of the helpers under `../../../lib/node/pi/bg-bash-*.ts` /
[`bash-gate.ts`](../../../lib/node/pi/bash-gate.ts) and run `/reload` in an interactive pi session to pick up changes
without restarting. Live jobs from the previous runtime survive the module reload (the `ChildProcess` handles are held
by closures that get replaced) — prefer restarting pi if you need to re-attach cleanly.
