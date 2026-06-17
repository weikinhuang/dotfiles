# `notify.ts`

Native desktop notification when an agent loop ends and pi is waiting on you - the same affordance Claude Code gives you
so you can tab away during a long turn and get pinged when it's your move. Platform detection is delegated to the repo's
[`quick-toast`](../../../dotenv/darwin/bin/quick-toast) bin script (darwin / linux / wsl variants, all on `$PATH`), so
this extension carries no per-OS escape-sequence logic of its own.

It ships two notification paths, mirroring Claude Code:

- a **lifecycle** notification driven by the `agent_end` hook (the harness decides), analogous to Claude Code's
  `Notification` hook; and
- a model-callable **`notify` tool** (the model decides), analogous to Claude Code's `PushNotification`.

## Composition

Listens on the same `agent_start` / `agent_end` boundary as [`titlebar-spinner.ts`](./titlebar-spinner.md), but the two
are orthogonal: the spinner drives the terminal title every turn for at-a-glance status, while `notify` fires an
out-of-band OS notification only for turns worth interrupting you for. Unlike pi's own `examples/extensions/notify.ts`
(which inlines OSC 777 / OSC 99 / Windows-toast detection and fires on every `agent_end`), this version shells out to
`quick-toast` and gates on duration + outcome.

## Detection

- On `agent_start` the extension records a start timestamp.
- On `agent_end` it computes the elapsed loop duration and summarizes the final assistant message via
  [`summarizeTurn`](../../../lib/node/pi/notify/desktop.ts) (last `role:"assistant"` entry: its text content, plus
  whether `stopReason` is `error` / `aborted`).
- [`shouldNotify`](../../../lib/node/pi/notify/desktop.ts) gates the fire:
  - **Errored or aborted** turns always notify, regardless of duration.
  - **Successful** turns notify only when the loop ran at least `PI_NOTIFY_MIN_SECONDS` (default 30s), so quick
    interactive back-and-forth stays silent.
- [`buildNotification`](../../../lib/node/pi/notify/desktop.ts) builds the content: title `<prefix> · <project>`
  (project = `basename(cwd)`); body is the first line of pi's final reply (whitespace-collapsed, truncated to 140
  chars), or a `Turn failed: …` / `Turn aborted` label on error, or `Turn complete - awaiting your input` when there's
  no text.
- The notifier is spawned detached and fire-and-forget (`stdio: 'ignore'`, `.unref()`); a missing binary or spawn error
  is swallowed (and traced) so it can never break a turn.

## `notify` tool

The extension registers a `notify` tool the model can call mid-turn, so it can reach you while still working - to flag a
blocking decision or a milestone in a long autonomous run, rather than waiting for the loop to end.

- **Parameters:** `message` (required body, one short line) and optional `title` (heading; defaults to the project
  name). Content is built by [`buildToolNotification`](../../../lib/node/pi/notify/desktop.ts), reusing the same
  `<prefix> · <heading>` title shape and 140-char body clamp as the lifecycle path. An empty `message` returns a tool
  error instead of firing.
- **No permission gate** - matches Claude Code's `PushNotification`. The tool description and prompt snippet steer the
  model to use it sparingly; routine progress belongs in the reply, not a notification.
- **No double ping** - when the tool fires during a turn, the lifecycle notification for that same turn is suppressed (a
  per-turn flag reset on `agent_start`). A long turn where the tool fired early still gets only the single tool ping.
- Disable just the tool (keeping lifecycle notifications) with `PI_NOTIFY_TOOL_DISABLED=1`; `PI_NOTIFY_DISABLED=1`
  disables both paths.

## Limitation

Subagents that run an agent loop in the same process emit their own `agent_start` / `agent_end`, so a long subagent turn
can produce a notification of its own. This matches `titlebar-spinner`'s precedent and is rarely a problem in practice;
set `PI_NOTIFY_MIN_SECONDS` higher or `PI_NOTIFY_DISABLED=1` if it's noisy for your workflow.

## Environment variables

- `PI_NOTIFY_DISABLED=1` - skip the extension entirely (lifecycle notification and tool).
- `PI_NOTIFY_TOOL_DISABLED=1` - keep lifecycle notifications but do not register the `notify` tool.
- `PI_NOTIFY_MIN_SECONDS=<n>` - minimum successful-turn duration before notifying (default `30`; `0` notifies on every
  successful turn).
- `PI_NOTIFY_COMMAND=<cmd>` - notifier binary (default `quick-toast`); invoked as `<cmd> <title> <body>`.
- `PI_NOTIFY_TITLE_PREFIX=<s>` - title prefix before the project name (default `pi`).
- `PI_NOTIFY_VERBOSE=1` - also `ctx.ui.notify` every decision in the pi UI.
- `PI_NOTIFY_TRACE=<path>` - append one line per decision to `<path>` (useful in `-p` / RPC modes where the UI notify is
  a no-op).

## Hot reload

Edit [`extensions/notify.ts`](./notify.ts) (or the [`desktop.ts`](../../../lib/node/pi/notify/desktop.ts) helper) and
run `/reload` in an interactive pi session to pick up changes without restarting.
