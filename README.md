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

### Add custom commands

If `~/.bash_local` exists, it will be sourced after the includes are sourced.

## .gitconfig.local

If a file `~/.gitconfig.local` exists, it will be sourced in addition to the built in git settings. Configurations in this file will be set with the highest priority.

## [WSL configuration](utils/wsl/README.md)

Setup and configuration of Window's WSL is documented in [utils/wsl/README.md](utils/wsl/README.md).

## Other variables for ~/.bash_local

To use these variables, export them to `~/.bash_local`.

```bash
# EXAMPLE
export AUTOLOAD_SSH_AGENT=1
```

| exported ENV var              | Description                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `__term_solarized_light=true` | Use to tell common commands to use solarized-light colors                                          |
| `INCLUDE_BREW_PATH=1`         | Use to homebrew utilities without the `g` prefix (OSX)                                             |
| `AUTOLOAD_SSH_AGENT=1`        | Automatically start up ssh-agent when starting a new shell, and reuse any existing agent instances |
