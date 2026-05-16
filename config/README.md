# Config

Non-shell configuration files consumed by third-party tools. The shell plugins in [`../plugins/`](../plugins/) wire most
of these directories into the relevant tool via env vars (`RIPGREP_CONFIG_PATH`, `BAT_CONFIG_PATH`, etc.); the subdirs
with their own `README.md` document custom tooling on top of the stock config.

## Directories

| Path                            | Consumer                                                                  | Notes                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [`bat/`](./bat/)                | `bat`                                                                     | `BAT_CONFIG_PATH` points here from [`plugins/30-bat.sh`](../plugins/30-bat.sh).                                              |
| [`claude/`](./claude/README.md) | [Claude Code](https://code.claude.com)                                    | Settings, custom statusline, session-usage CLI. See [`claude/AGENTS.md`](./claude/AGENTS.md) for edit rules.                 |
| [`codex/`](./codex/README.md)   | [Codex CLI](https://github.com/openai/codex)                              | `config.toml` + session-usage CLI.                                                                                           |
| [`eza/`](./eza/)                | `eza`                                                                     | Solarized theme files symlinked into `~/.config/eza/theme.yml` by [`plugins/10-eza.sh`](../plugins/10-eza.sh).               |
| [`git/`](./git/)                | `git`                                                                     | Split `.gitconfig` fragments and global ignore/attributes, installed by [`bootstrap.sh`](../bootstrap.sh).                   |
| [`opencode/`](./opencode/)      | [opencode](https://opencode.ai)                                           | `opencode.jsonc` settings + session-usage CLI.                                                                               |
| [`pi/`](./pi/README.md)         | [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) | Settings, extensions, skills, subagent definitions, themes, session-usage CLI.                                               |
| [`ripgrep/`](./ripgrep/)        | `ripgrep`                                                                 | `RIPGREP_CONFIG_PATH` points here from [`plugins/10-ripgrep.sh`](../plugins/10-ripgrep.sh).                                  |
| [`tmux/`](./tmux/)              | `tmux`                                                                    | Helper `.conf` fragments sourced by [`../tmux.conf`](../tmux.conf).                                                          |
| [`vim/`](./vim/)                | `vim` / `neovim`                                                          | Mapping, autocommand, filetype, and per-filetype setup loaded from [`../vimrc`](../vimrc) and the Neovim `init.lua` wrapper. |

## Related docs

- [../AGENTS.md](../AGENTS.md) - root agent guide.
- [../REFERENCE.md](../REFERENCE.md) - "Tool defaults" table cross-referencing each config directory to the shell plugin
  that consumes it.
- [pi/README.md](./pi/README.md) - pi config (deepest subtree - has its own extension / skill / agent indexes).
- [claude/README.md](./claude/README.md) - Claude Code config.
- [codex/README.md](./codex/README.md) - Codex CLI config.
