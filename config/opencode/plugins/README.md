# opencode plugins

opencode v2 plugins built on [`@opencode/plugin`](https://opencode.ai/docs/build/plugins), mostly ports of the pi
extensions under [`config/pi/extensions/`](../../pi/extensions/README.md). Each plugin is a directory that opencode
loads directly as TypeScript; there is no build step. Authoring conventions for contributors are in
[AGENTS.md](./AGENTS.md).

## Plugins

| Plugin                                 | Parts            | Description                                                                                    |
| -------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| [`cost-guard`](./cost-guard/README.md) | server, tui, rpc | Local-only cache-rewrite and spend warnings as TUI toasts and a status slot (pi `cost-guard`). |
| [`notify`](./notify/README.md)         | server           | `notify` tool plus a turn-end desktop notification via `quick-toast` (pi `notify`).            |

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

Symlink a plugin directory into the global plugin directory; opencode discovers direct `.ts` / `.js` files and immediate
subdirectories there and in every project's `.opencode/plugins/`:

```bash
mkdir -p ~/.config/opencode/plugins
ln -s ~/.dotfiles/config/opencode/plugins/notify ~/.config/opencode/plugins/notify
```

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

opencode watches only each plugin's entry file. After editing a helper under `lib/node/`, restart opencode
(`opencode service restart` for the background service).

## Runtime resolution

opencode runs plugins in its embedded Bun runtime, which transpiles TypeScript and JSX on load. Verified on 2.2.7:

- The entry point resolves to its real path through the symlink, so relative imports such as
  `../../../../lib/node/opencode/notify.ts` and bare dependencies from the repo's `node_modules` (for example `yaml`)
  load from the dotfiles checkout.
- `@opencode/plugin` (all subpaths) and `effect` are always the host's own copies, intercepted by opencode regardless of
  what `node_modules` holds. The repo pins `@opencode/plugin` to the local opencode version for type-checking only.
- TUI parts import `@opencode/plugin/tui`, `solid-js`, and `@opentui/*`; opencode resolves those at runtime as well.

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
./dev/opencode-plugin-smoke.sh stop demo
```

The default model is `github-copilot/claude-haiku-5.5` (override with `-m`). The TUI runs with highlights and native
attention notifications off (`--cli-config` overrides that). Run `./dev/opencode-plugin-smoke.sh --help` for every
option.
