# `notify`

Desktop notifications for opencode, ported from the pi [`notify`](../../../pi/extensions/notify.md) extension. Delivery
goes through the repo's `quick-toast` bin script (darwin / linux / wsl variants on `$PATH`), spawned detached and
fire-and-forget, so the plugin has no per-OS logic. Server part only: [`server.ts`](./server.ts), with the logic in
[`lib/node/opencode/notify.ts`](../../../../lib/node/opencode/notify.ts) and the shared content / gating helpers in
[`lib/node/pi/notify/desktop.ts`](../../../../lib/node/pi/notify/desktop.ts).

## `notify` tool

A direct tool (`codemode: false`, so the model calls it by name instead of through `execute`) with no permission gate,
matching Claude Code's `PushNotification`. Parameters: `message` (required, one short line) and optional `title`
(defaults to the project name). The notification title is `<titlePrefix> · <title or project>`; the body is the first
line of `message`, clamped to 140 characters. An empty `message` fails the tool call.

## Lifecycle notification

The plugin subscribes to `session.execution.{started,succeeded,failed,interrupted}` and `session.text.ended`. When an
execution ends:

- **Child sessions** (subagents, any session with a `parentID`) never notify.
- **Interrupts** with reason `shutdown` (opencode exiting) or `superseded` (a newer prompt replaced the run) never
  notify.
- **Tool already fired**: if `notify` ran during the turn, in the root session or any subagent under it, the lifecycle
  notification is suppressed.
- **Failed or user-interrupted** turns always notify (`Turn failed: <error>` / `Turn aborted: ...`).
- **Successful** turns notify only when the execution ran at least `minSeconds` (default 30). The body is the last
  assistant text block of the turn, or `Turn complete - awaiting your input` when there was none.

## Coexistence with native notifications

opencode's built-in `opencode.notifications` TUI plugin shows a system notification whenever a session finishes, fails,
asks for permission, or opens a question form, but only while the terminal is blurred, and it is controlled by
`attention.notifications` in `cli.json`. With both enabled, a long turn finishing while you are tabbed away pings twice.

The lifecycle path stays on by default because its duration gate, reply-snippet body, and `quick-toast` delivery (which
reaches Windows from WSL) are the reason to port it. Pick one turn-end notifier:

- **Keep this plugin's lifecycle path** (default): set `"attention": { "notifications": false }` in `cli.json`. Native
  attention sounds, including permission and question sounds, keep playing because `attention.sound` is separate.
- **Keep native notifications**: set the plugin option `"lifecycle": false` (or `OPENCODE_NOTIFY_LIFECYCLE=0`). The
  `notify` tool still works.

Native notifications are focus-aware and cover permission prompts, which this plugin does not; this plugin cannot see
terminal focus because it runs in the server.

## Options

Set options with a plugin entry in `opencode.jsonc` (see [Install](../README.md#install)). Every option also has an
`OPENCODE_NOTIFY_*` environment override, which wins over the option.

| Option        | Env override                   | Default       | Effect                                                     |
| ------------- | ------------------------------ | ------------- | ---------------------------------------------------------- |
| `enabled`     | `OPENCODE_NOTIFY_ENABLED`      | `true`        | `false` disables the plugin entirely.                      |
| `tool`        | `OPENCODE_NOTIFY_TOOL`         | `true`        | Register the `notify` tool.                                |
| `lifecycle`   | `OPENCODE_NOTIFY_LIFECYCLE`    | `true`        | Notify when a root-session turn ends.                      |
| `minSeconds`  | `OPENCODE_NOTIFY_MIN_SECONDS`  | `30`          | Minimum successful-turn duration; `0` notifies every turn. |
| `command`     | `OPENCODE_NOTIFY_COMMAND`      | `quick-toast` | Notifier binary, invoked as `<command> <title> <body>`.    |
| `titlePrefix` | `OPENCODE_NOTIFY_TITLE_PREFIX` | `opencode`    | Title prefix before the project name.                      |
| `trace`       | `OPENCODE_NOTIFY_TRACE`        | unset         | Append one line per decision to this file.                 |

Booleans accept `true` / `false` or the dotenv `1` / `0`, `yes` / `no`, `on` / `off` words.

## Limitations

- Notifications fire on the machine running the opencode server. With `--server` against a remote host, use native
  notifications instead.
- Each execution is timed separately. When a background subagent's report wakes the root session, that wake-up is a new
  execution, so a long task split across wake-ups may not reach `minSeconds` in any single one.
- opencode watches only the plugin entry file; restart opencode after editing the `lib/node/` helpers.

## Live test

```bash
D="$(./dev/opencode-plugin-smoke.sh dir ocnotify)"
./dev/opencode-plugin-smoke.sh start -n ocnotify -s quick-toast \
  -o "notify={\"minSeconds\":0,\"trace\":\"$D/trace.log\"}" notify
./dev/opencode-plugin-smoke.sh send ocnotify 'Call the notify tool once with message SMOKE_TOOL_OK, then reply done.'
./dev/opencode-plugin-smoke.sh wait ocnotify '✓ notify'
cat "$D/stub-quick-toast.log" "$D/trace.log"
./dev/opencode-plugin-smoke.sh stop ocnotify
```
