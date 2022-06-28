# weikinhuang's dotfiles

My `$SHELL`, mostly bash, works everywhere, `*nix`, `osx`, `wsl`.

## Installation

The bootstrap script will create symlinks in the home directory to the proper files. The script will also create `*.bak` files for backups of existing files.

### Install dotfiles with auto bootstrap

This will by default install dotfiles in the home directory with all options enabled

```bash
curl https://raw.githubusercontent.com/weikinhuang/dotfiles/master/bootstrap.sh | bash

# Additional arguments can be passed to the bootstrap script
curl https://raw.github...master/bootstrap.sh | bash -s -- [args]
```

### Install dotfiles with Git

You can clone the repository wherever you want, the home (`~/`) directory is recommended.

When the git repo is updated, the files will be automatically updated when the session is restarted.

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

## [Reference for aliases and functions](REFERENCE.md)

See [REFERENCE.md](REFERENCE.md) for all added commands, overrides, and changes to built-ins.

## [The Bash Prompt](PROMPT.md)

See [PROMPT.md](PROMPT.md) for configuration options.

![Prompt example](./assets/prompt-example.png)

## Configuration Options

To use these variables, export them to `~/.bash_local`.

```bash
# EXAMPLE
export DOT_AUTOLOAD_SSH_AGENT=1
```

| exported ENV var              | Set Value To | Description                                                                                        |
| ----------------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| `DOT_AUTOLOAD_SSH_AGENT`      | `1`          | Automatically start up ssh-agent when starting a new shell, and reuse any existing agent instances |
| `DOT_BASH_RESOLVE_PATHS`      | `1`          | Set bash option `set -o physical` to not resolve symlink paths                                     |
| `DOT_DISABLE_PREEXEC`         | `1`          | Disables loading [`bash-preexec.sh`](https://github.com/rcaloras/bash-preexec) functionality       |
| `DOT_INCLUDE_BREW_PATH`       | `1`          | Use to homebrew utilities without the `g` prefix (OSX)                                             |
| `DOT_INCLUDE_BUILTIN_PLUGINS` | `1`          | Loads files in dotfiles/plugins                                                                    |
| `DOT_SOLARIZED_DARK`          | `1`          | Use to tell common commands to use solarizeddark colors                                            |
| `DOT_SOLARIZED_LIGHT`         | `1`          | Use to tell common commands to use solarized light colors                                          |

## Custom hook points

### `~/.bash_local`

If `~/.bash_local` exists, it will be sourced before the built-ins are sourced. Env vars, configuration vars, and hooks can be placed in this file.

### `~/.bash_local.d/*.sh`

All files ending with `.sh` located in `~/.bash_local.d` will be loaded right after `~/.bash_local`, this is a good place to put include scripts that setup additional environments in separate files.

## .gitconfig.local

If a file `~/.gitconfig.local` exists, it will be sourced in addition to the built in git settings. Configurations in this file will be set with the highest priority.

## Plugins

TODO

See the [plugins/](./plugins/) directory for examples.

## Hooks

TODO

## [WSL configuration](utils/wsl/README.md)

Setup and configuration of Window's WSL is documented in [utils/wsl/README.md](utils/wsl/README.md).
