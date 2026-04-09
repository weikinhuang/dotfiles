# weikinhuang's dotfiles

My `$SHELL`, mostly bash, works everywhere, `*nix`, `osx`, `wsl`.

## Installation

The bootstrap script will create symlinks in the home directory to the proper files. The script will also create `*.bak` files for backups of existing files.

### Install dotfiles with auto bootstrap

This will by default install dotfiles in the home directory with all options enabled

```bash
curl -fsSL https://raw.githubusercontent.com/weikinhuang/dotfiles/master/bootstrap.sh | bash

# Additional arguments can be passed to the bootstrap script
curl -fsSL https://raw.githubusercontent.com/weikinhuang/dotfiles/master/bootstrap.sh | bash -s -- [args]
```

### Install dotfiles with Git

You can clone the repository wherever you want, the home (`~/`) directory is recommended.

Because the installed files are symlinked into your home directory, pulling updates in the repo takes effect in new shells.

```bash
# args can be passed to the bootstrap script
git clone https://github.com/weikinhuang/dotfiles.git ~/.dotfiles && ~/.dotfiles/bootstrap.sh
```

To update later on, just run `git pull` in `~/.dotfiles`.

### Install dotfiles without Git

To install or update without git installed, run:

```bash
cd; mkdir -p ~/.dotfiles \
  && curl -#L https://github.com/weikinhuang/dotfiles/tarball/master \
    | tar -C ~/.dotfiles -xzv --strip-components 1 \
  && ~/.dotfiles/bootstrap.sh
```

### `bootstrap.sh` args

| Arg          | Description                         |
| ------------ | ----------------------------------- |
| `--dir PATH` | Change the install directory        |
| `--no-git`   | Skip setting up `.gitconfig`        |
| `--no-vim`   | Skip setting up `.vimrc` and `.vim` |

## [Reference for aliases, functions, and changes](./REFERENCE.md)

See [REFERENCE.md](./REFERENCE.md) for all added commands, overrides, and changes to built-ins.

### High level overview

- `chpwd`, `precmd`, and `preexec` hooks with similar behavior to [**Zsh**](https://zsh.sourceforge.io/Doc/Release/Functions.html#Hook-Functions)
- `sudo` works on aliases
- `rm` `cp` `mv` are always interactive `-i` (use `-f` to override)
- `ls` and `grep` default to color when the local implementation supports it
- `which` expands aliases and full paths when the local implementation supports it
- `gdiff` uses git's diff command with color when possible
- `pbcopy` and `pbpaste` for cross-platform copy/paste from cli, and optionally over ssh
- `open` for cross-platform open in native application
- `chattr`, `mklink`, `is-elevated-session`, `winstart`, `winsudo` WSL tools

### With `DOT_INCLUDE_BUILTIN_PLUGINS=1`

Examples:

- `cd --` lists the directory stack (current directory plus up to 10 previous entries)
- `less` does not clear the screen upon exit and processes colors
- the prompt can render git status when the git plugin is active

## [The Bash Prompt](./PROMPT.md)

See [PROMPT.md](./PROMPT.md) for configuration options.

![Prompt example](./assets/prompt-example.svg)

## Configuration Options

To use these variables, export them to `~/.bash_local`.

```bash
# EXAMPLE
export DOT_AUTOLOAD_SSH_AGENT=1
```

| exported ENV var | Default | Description |
| --- | ---: | --- |
| `DOT_AUTOLOAD_SSH_AGENT` | `UNSET` | When the SSH plugin is enabled, automatically start `ssh-agent` or reuse an existing agent |
| `DOT_BASH_RESOLVE_PATHS` | `UNSET` | Set Bash option `set -o physical` to avoid resolving symlink paths |
| `DOT_DISABLE_HYPERLINKS` | `UNSET` | Suppress OSC 8 hyperlinks emitted by `ls`, `eza`, `rg`, `fd`, and `delta` |
| `DOT_DISABLE_PREEXEC` | `UNSET` | Skip loading [`bash-preexec.sh`](https://github.com/rcaloras/bash-preexec), disabling `preexec` hooks and command timing features |
| `DOT_DISABLE_PS1` | `UNSET` | Disable the custom Bash prompt |
| `DOT_GIT_PROMPT_CACHE_MAX_AGE_MS` | `10000` | Maximum milliseconds to reuse unchanged git prompt status before forcing a refresh |
| `DOT_GIT_PROMPT_CACHE_TTL_MS` | `1000` | Milliseconds to reuse cached git prompt status before checking the current repo again |
| `DOT_GIT_PROMPT_INVALIDATE_ON_GIT` | `1` | Set to `0` to disable automatic git prompt cache invalidation after git commands |
| `DOT_INCLUDE_BREW_PATH` | `UNSET` | On macOS with built-in plugins enabled, prepend Homebrew and GNU tool paths and extend `MANPATH` |
| `DOT_INCLUDE_BUILTIN_PLUGINS` | `UNSET` | Load the full built-in [`plugins/*.sh`](./plugins) set instead of only `00-bash-opts.sh` and `00-chpwd-hook.sh` |
| `DOT_SOLARIZED_DARK` | `UNSET` | Choose Solarized Dark where theme-aware integrations support it |
| `DOT_SOLARIZED_LIGHT` | `UNSET` | Choose Solarized Light where theme-aware integrations support it |

## Custom hook points

### `~/.bash_local`

If `~/.bash_local` exists, it will be sourced before the built-ins are sourced. Env vars, configuration vars, and hooks can be placed in this file.

### `~/.bash_local.d/*.sh`

All files ending with `.sh` located in `~/.bash_local.d` are loaded right after `~/.bash_local` and before the repo's built-ins. This is a good place to split local environment setup into separate files.

## .gitconfig.local

If a file `~/.gitconfig.local` exists, it will be included in addition to the built-in git settings. Configurations in this file have the highest priority.

## Plugins

Plugins are scripts that are loaded near the end of the dotfiles initialization process. They usually contain hooks, setup, or configuration for external programs.

By default only [`plugins/00-bash-opts.sh`](./plugins/00-bash-opts.sh) and [`plugins/00-chpwd-hook.sh`](./plugins/00-chpwd-hook.sh) load. Set `DOT_INCLUDE_BUILTIN_PLUGINS=1` before startup to load the full built-in plugin set.

See the [plugins/](./plugins/) directory for the built-in examples.

Plugins are also loaded from `~/.bash_local.d/` with any file ending in `.plugin`. Local `.plugin` files load in the plugin phase and interleave with built-ins by basename.

Example plugin for [`direnv`](https://direnv.net/):

```bash
# check if direnv exists
if ! command -v direnv &>/dev/null; then
  return
fi
# load direnv program hook
eval "$(direnv hook bash 2>/dev/null)"
```

Specific plugins can be disabled with an environment variable named after the plugin basename without its numeric prefix. Examples: `DOT_PLUGIN_DISABLE_direnv=1`, `DOT_PLUGIN_DISABLE_fzf=1`.

Example disable direnv hook:

```bash
export DOT_PLUGIN_DISABLE_direnv=1
```

## Hooks

Hooks are available before and after each part of the dotfiles repo is loaded. This allows for customization between steps or overrides at point in time loading. They should be declared in `~/.bash_local` or `~/.bash_local.d/*.sh` so that they are available by the time the dotfiles are loaded.

Hook points are available before and after the following steps:

- `aliases`
- `completion`
- `env`
- `exports`
- `extra`
- `functions`
- `plugin`
- `prompt`

They can be declared as either a single function `dotfiles_hook_${PHASE}_{pre,post}` or pushed into the arrays `dotfiles_hook_${PHASE}_{pre,post}_functions`.

Example

```bash
# add a hook to run before the "functions" segment is loaded
function dotfiles_hook_functions_pre() {
    echo "I'm loading before functions"
    export FOO=123
}

# add a hook to run after the "aliases" segment is loaded
function foobar() {
    echo "I'm loading after aliases"
    alias curl-help="curl --help"
}
# append to array
dotfiles_hook_aliases_post_functions+=(foobar)
```

## [WSL configuration](utils/wsl/README.md)

Setup and configuration of Windows WSL is documented in [utils/wsl/README.md](utils/wsl/README.md).

## Development

You can try out this repo in `docker` easily to test your plugins or hooks.

```bash
$ docker run -it --rm -v "$(pwd):/root/.dotfiles:ro" -v "$HOME/.bash_local:/root/.bash_local:ro" -v "$HOME/.bash_local.d:/root/.bash_local.d:ro" -v "$(pwd)/dev/docker-entrypoint.sh:/docker-entrypoint.sh:ro" --entrypoint /docker-entrypoint.sh bash:latest bash
# OR with overrides set locally in the dotfiles repo
mkdir -p bash_local_d_sample
touch bash_local_d_sample/bash_local
$ docker run -it --rm -v "$(pwd):/root/.dotfiles:ro" -v "$(pwd)/bash_local_d_sample/bash_local:/root/.bash_local:ro" -v "$(pwd)/bash_local_d_sample:/root/.bash_local.d:ro" -v "$(pwd)/dev/docker-entrypoint.sh:/docker-entrypoint.sh:ro" -v "$(pwd)/bash_local_d_sample/.bash_history:/root/.bash_history" --entrypoint /docker-entrypoint.sh bash:latest bash

# in the docker shell
$ (cd ~ && .dotfiles/bootstrap.sh)
# install any dependencies you might need, ex.
$ apk add --no-cache coreutils curl git tar nodejs

# start a new shell with the dotfiles loaded, to reload, exit this shell and run this command again
$ env -i PS1=1 TERM="$TERM" PATH="$PATH" HOME="$HOME" SHELL="$SHELL" bash -l
$ CTRL+d
$ env -i PS1=1 TERM="$TERM" PATH="$PATH" HOME="$HOME" SHELL="$SHELL" bash -l
...
```

### Brewfile

A [`Brewfile`](./Brewfile) is included for declaratively managing core Homebrew packages on macOS. Install with:

```bash
brew bundle --file=~/.dotfiles/Brewfile
```

### Linting

[`shellcheck`](https://github.com/koalaman/shellcheck) and [`shfmt`](https://github.com/mvdan/sh) are used to ensure consistency of the scripts in this repo. Files in `external/` are excluded since they are third-party. `.bats` tests are also checked with ShellCheck using its Bats parser.

Validate the codebase locally:

```bash
$ ./dev/lint.sh
OK
```

### Layout

The loader recognizes the following phase files in `dotenv/` and in any active platform-specific subdirectory. Only create the files you need.

| File         | Description                                                            |
| ------------ | ---------------------------------------------------------------------- |
| `aliases`    | bash aliases declared via `alias name="some command"`                   |
| `completion` | bash completion functions for `complete`                               |
| `env`        | any additional bash-isms that don't fall in the above category         |
| `exports`    | environment vars that are exported via `export`                        |
| `extra`      | any additional bash-isms that don't fall in the above category         |
| `functions`  | bash function declarations, can be exported via `export -f FN_NAME`    |
| `prompt`     | scripts to generate or modify the prompt vars `PS1`, `PS2`, `SUDO_PS1` |

Supporting directories:

- `dotenv/bin/` and `dotenv/bin.$(uname -m)` are added to `PATH` on all platforms.
- Active platform directories can also contribute `bin/` and `bin.$(uname -m)`.
- `dotenv/lib/` contains internal helpers used by the loader, prompt, and shared shell code.

Supported platform directories:

| Path | Used when |
| --- | --- |
| `dotenv/` | always |
| `dotenv/darwin/` | on macOS |
| `dotenv/linux/` | on Linux |
| `dotenv/wsl/` | on WSL |
| `dotenv/wsl2/` | on WSL 2 |
| `dotenv/tmux/` | inside tmux |
| `dotenv/screen/` | inside screen |
| `dotenv/ssh/` | in SSH sessions |

### File loading order

Local overrides load first:

1. `~/.bash_local`
2. `~/.bash_local.d/*.sh`

Then each phase resolves in the following order:

1. `dotenv/*.sh`
2. `dotenv/${DOTENV}/*.sh`
3. `dotenv/wsl/*.sh` on WSL
4. `dotenv/wsl2/*.sh` on WSL 2
5. `dotenv/tmux/*.sh` in tmux
6. `dotenv/screen/*.sh` in screen
7. `dotenv/ssh/*.sh` over SSH
8. `~/.<phase>`

Phases run in the following order:

1. `exports`
2. `functions`
3. `aliases`
4. `extra`
5. `env`
6. `completion` when Bash completion is available
7. `plugins`
8. `prompt`

Built-in plugins load only when `DOT_INCLUDE_BUILTIN_PLUGINS=1` is set before startup, except for `00-bash-opts.sh` and `00-chpwd-hook.sh`, which load by default. Local `~/.bash_local.d/*.plugin` files load in the plugin phase and interleave with built-ins by basename.
