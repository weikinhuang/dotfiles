# opencode plugins

opencode v2 plugins built on [`@opencode/plugin`](https://opencode.ai/docs/build/plugins), mostly ports of the pi
extensions under [`config/pi/extensions/`](../../pi/extensions/README.md). Each plugin is a directory that opencode
loads directly as TypeScript; there is no build step. Authoring conventions for contributors are in
[AGENTS.md](./AGENTS.md).

## Plugins

| Plugin                                           | Parts            | Description                                                                                                       |
| ------------------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| [`context-edit`](./context-edit/README.md)       | server, tui, rpc | Reversible overlay that collapses tool output and drops images: `/context-edit`, `collapse_output`, `drop_image`. |
| [`cost-guard`](./cost-guard/README.md)           | server, tui, rpc | Local-only cache-rewrite and spend warnings as TUI toasts and a status slot (pi `cost-guard`).                    |
| [`memory`](./memory/README.md)                   | server, tui, rpc | Cross-session memory tool and index sharing pi's `~/.pi/agent/memory` store; `/memory` reports (pi `memory`).     |
| [`notify`](./notify/README.md)                   | server           | `notify` tool plus a turn-end desktop notification via `quick-toast` (pi `notify`).                               |
| [`secret-redactor`](./secret-redactor/README.md) | server, tui, rpc | Redact secrets from model requests; approval-gated rehydration into tool calls (pi `secret-redactor`).            |
| [`statusline`](./statusline/README.md)           | tui              | Git flags, worktree, cache-hit ratio, tool count, and session id in the prompt footer (pi `statusline`).          |

## Layout

```text
config/opencode/plugins/
├── tsconfig.json        # type-checks this tree (DOM lib + OpenTUI JSX for TUI parts)
└── <name>/
    ├── server.ts        # server part: Plugin.define from @opencode/plugin
    ├── tui.tsx          # optional TUI part: Plugin.define from @opencode/plugin/tui
    ├── rpc.ts           # optional RPC contract shared by server and TUI
    └── README.md        # user-facing doc: behavior, options, limitations, live test
```

A plugin directory without a `package.json` is loaded by file name: `server` (else `index`), `tui`, and `rpc`, each with
a `.ts`, `.tsx`, or `.js` extension. Plugin ids use a `dotfiles.<name>` prefix. Business logic lives in pure helpers
under [`lib/node/opencode/`](../../../lib/node/opencode/) (or reused from [`lib/node/pi/`](../../../lib/node/pi/)), with
specs under [`tests/lib/node/opencode/`](../../../tests/lib/node/opencode/).

## Install

opencode discovers direct `.ts` / `.js` files and immediate subdirectories in `<config dir>/plugins/` (and `plugin/`)
and in every project's `.opencode/plugins/`. [`install.sh`](./install.sh) symlinks each plugin into the global plugins
directory one link at a time, so other plugins can live beside them:

```bash
~/.dotfiles/config/opencode/plugins/install.sh                  # every plugin
~/.dotfiles/config/opencode/plugins/install.sh notify memory    # just these
~/.dotfiles/config/opencode/plugins/install.sh --list           # installed / not installed
~/.dotfiles/config/opencode/plugins/install.sh --uninstall notify
~/.dotfiles/config/opencode/plugins/install.sh -p work          # the `opencode -u work` profile
opencode service restart                                        # pick up the change
```

The default target is `${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-~/.config}/opencode}/plugins` (`--dir` overrides it).
The script never replaces a real file or directory, replaces a symlink that points elsewhere only with `--force`, and
`--uninstall` removes only links that point into this repo.

Discovered plugins get empty options. To pass options, also add an entry for the same directory to
`~/.config/opencode/opencode.jsonc`; relative paths resolve from that file, and the plugin still loads once:

```jsonc
{
  "plugins": [{ "package": "./plugins/notify", "options": { "minSeconds": 60 } }],
}
```

Plugins that read options also accept environment overrides (documented per plugin), which suit per-shell or per-profile
tweaks through `<config dir>/env` (see [Profiles](../README.md#profiles)). Options in `opencode.jsonc` reach only the
server part: a TUI part's `context.options` was empty in testing, so hand TUI settings over through RPC from the server
part.

opencode hot-reloads a plugin when its entry changes and logs watchers on its imports too, but reloads of `lib/node/`
helpers have not been reliable. After editing a helper, restart opencode (`opencode service restart` for the background
service).

## Runtime resolution

opencode runs plugins in its embedded Bun runtime, which transpiles TypeScript and JSX on load. Verified on 2.2.7:

- The entry point resolves to its real path through the symlink, so relative imports such as
  `../../../../lib/node/opencode/notify.ts` and bare dependencies from the repo's `node_modules` (for example `yaml`)
  load from the dotfiles checkout.
- `@opencode/plugin` (all subpaths) and `effect` are always the host's own copies, intercepted by opencode regardless of
  what `node_modules` holds. The repo pins `@opencode/plugin` to the local opencode version for type-checking only.
- TUI parts import `@opencode/plugin/tui`, `solid-js`, and `@opentui/*`; opencode resolves those at runtime as well.

## Runtime gotchas (opencode 2.2.7)

- No `@types/bun`: use `import.meta.dirname`, not `import.meta.dir`.
- `@opencode/plugin` and `effect` are always the host's copies; other bare deps resolve from the repo `node_modules`.
- The server watches the entry and its imports, but restart opencode if a `lib/node/` helper change does not take.
- TUI parts do not receive `opencode.jsonc` options (use env vars); `opencode plugin list` shows only package plugins.
- A TUI `keymap.layer` needs `mode: "global"`; the default `base` layer is not active inside a session.
- Footer slots (`prompt.footer.status`): keep contributions content-sized. `flexGrow` permanently truncates the native
  location label. Measure the row with an absolutely positioned probe
  (`position="absolute" left={0} right={0} height={0} onSizeChange`); terminal width is not the budget. Theme colors are
  `RGBA` from `@opentui/core`.
- opencode's prompt for a custom action only says `Call tool <action>` (metadata is not shown); surface details with a
  TUI toast on `permission.asked`. Shell permission runs after `tool.execute.before`, so it sees rewritten input.
- `ctx.session.context` returns only history since the latest compaction; there is no full message-list API.
  `Session.Info.cost` excludes child sessions. `session.usage.recorded` (title / generate usage) never reaches plugins.
- Per-call usage arrives on `session.step.ended` (`cost` + `tokens`, after the step's tools settle); the model is on
  `session.step.started`, keyed by `assistantMessageID`.
- `opencode serve` and `--server` need `OPENCODE_PASSWORD`, and the client's cwd picks the location to boot.
- One user turn can span several root executions (subagent reports wake the session); each has its own `started` /
  terminal pair, and a terminal event may repeat, so dedupe per execution.
- `ctx.session.instructions.entry`: a put from the `prompt` hook lands in that prompt's first request (a new session's
  baseline); a put from the `context` hook is announced only at the next step boundary (per source). A changed entry is
  replayed as its full new value, a removal as "no longer applies", and an unchanged put is a no-op. Forks copy the
  entries.
- `context` hook `event.tools` is keyed by tool name; deleting a key hides that tool for the request (subagent gating).
- Harness: `send` echoes the prompt into the pane, so anchor `wait` patterns (for example `'^ +DONE1'`).

## Live testing

[`dev/opencode-plugin-smoke.sh`](../../../dev/opencode-plugin-smoke.sh) builds a scratch project under
`/tmp/opencode-smoke-<name>/` whose `.opencode/plugins/` symlinks the selected plugins, then drives
`opencode --standalone` in a detached tmux session. It never writes to `~/.config/opencode` or uses the background
service, but sessions still land in the default opencode database, which also holds the credentials.

```bash
# Load-only check: boots a private `opencode serve`, prints plugin load lines and warnings; exit 1 on a load failure.
./dev/opencode-plugin-smoke.sh check notify

# Interactive TUI run with a stubbed quick-toast and plugin options.
./dev/opencode-plugin-smoke.sh start -n demo -s quick-toast -o 'notify={"minSeconds":0}' notify
./dev/opencode-plugin-smoke.sh send demo 'Reply with exactly: READY'
./dev/opencode-plugin-smoke.sh wait demo '^ +READY' 90
./dev/opencode-plugin-smoke.sh capture demo 15
cat "$(./dev/opencode-plugin-smoke.sh dir demo)/stub-quick-toast.log"

# Relaunch in the same scratch dir (same plugins, options, stubs, env) and reopen the last session.
./dev/opencode-plugin-smoke.sh restart demo --continue
./dev/opencode-plugin-smoke.sh stop demo
```

`start` and `restart` return once the TUI has rendered its prompt, so the first `send` is not lost.

The default model is `github-copilot/claude-haiku-5.5` (override with `-m`). The TUI runs with highlights and native
attention notifications off (`--cli-config` overrides that). Run `./dev/opencode-plugin-smoke.sh --help` for every
option.
