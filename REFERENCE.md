# weikinhuang's dotfiles reference

This file documents the public shell interface exposed by this repo.

Important: only [`plugins/00-bash-opts.sh`](./plugins/00-bash-opts.sh) and [`plugins/00-chpwd-hook.sh`](./plugins/00-chpwd-hook.sh) load by default. The rest of [`plugins/*.sh`](./plugins) load only when `DOT_INCLUDE_BUILTIN_PLUGINS=1` is set before startup.

Plugin disable variables use the basename without the numeric prefix. Examples:

- [`plugins/00-direnv.sh`](./plugins/00-direnv.sh) -> `DOT_PLUGIN_DISABLE_direnv=1`
- [`plugins/10-fzf.sh`](./plugins/10-fzf.sh) -> `DOT_PLUGIN_DISABLE_fzf=1`
- `~/.bash_local.d/05-alpha.plugin` -> `DOT_PLUGIN_DISABLE_alpha=1`
- `~/.bash_local.d/my.plugin` -> `DOT_PLUGIN_DISABLE_my=1`

## Load model

| Layer | Order | Notes |
| --- | --- | --- |
| Local prelude | first | `~/.bash_local`, then `~/.bash_local.d/*.sh` |
| Core phases | next | `exports` -> `functions` -> `aliases` -> `extra` -> `env` -> `completion` |
| Plugin phase | next | built-ins plus `~/.bash_local.d/*.plugin`; when local plugins exist they are interleaved by basename |
| Prompt phase | last | prompt loads after plugins so prompt helpers can depend on plugin state |
| Phase resolution | for each phase | `dotenv/` -> `dotenv/${DOTENV}/` -> `dotenv/wsl/` -> `dotenv/wsl2/` -> `dotenv/tmux/` -> `dotenv/screen/` -> `dotenv/ssh/` -> `~/.<phase>` |

## Tool defaults

The repo also sets defaults for common tools through shell plugins and checked-in config files.

Notes:

- Most tool integrations below require `DOT_INCLUDE_BUILTIN_PLUGINS=1`.
- Plugin-provided defaults generally respect an existing env var instead of overwriting it.
- [`curlrc`](./curlrc), [`wgetrc`](./wgetrc), [`inputrc`](./inputrc), [`gitconfig`](./gitconfig), [`vimrc`](./vimrc), and similar top-level files are installed via [`bootstrap.sh`](./bootstrap.sh), so those defaults apply independently of shell plugin loading.

| Tool | Source | What gets configured |
| --- | --- | --- |
| `bat` | [`plugins/30-bat.sh`](./plugins/30-bat.sh), [`config/bat/config`](./config/bat/config) | Config file path, Solarized theme selection, colored `MANPAGER`, `cat` alias, `batcat` fallback |
| `curl` | top-level [`curlrc`](./curlrc) | Repo-managed curl defaults via installed `~/.curlrc` |
| `delta` | [`plugins/30-delta.sh`](./plugins/30-delta.sh) | Generates `~/.config/dotfiles/git-delta.gitconfig` and enables delta as the git pager when installed |
| `difftastic` | [`plugins/30-difftastic.sh`](./plugins/30-difftastic.sh) | Exports default display settings and generates `~/.config/dotfiles/git-difftastic.gitconfig` |
| `direnv` | [`plugins/00-direnv.sh`](./plugins/00-direnv.sh) | Silent log format and automatic `direnv hook bash` loading |
| `docker` / `podman` | [`plugins/80-podman.sh`](./plugins/80-podman.sh), [`plugins/90-docker.sh`](./plugins/90-docker.sh) | Compatibility wrappers, history filtering, and Compose timeout defaults |
| `eza` | [`plugins/10-eza.sh`](./plugins/10-eza.sh), [`config/eza/`](./config/eza) | Replaces list aliases, adds `lt`, and links a Solarized theme into `~/.config/eza/theme.yml` |
| `fd` | [`plugins/10-fd.sh`](./plugins/10-fd.sh) | Aliases `fd` with `--hyperlink=auto`, adds `findhere`, with automatic `fdfind` fallback on Debian-family systems |
| `fzf` | [`plugins/10-fzf.sh`](./plugins/10-fzf.sh) | Reverse layout, 40% height, border, inline info, history scoring, `fd`-backed file and directory pickers, previews via `bat` and `tree` when available |
| `jq` | [`plugins/10-jq.sh`](./plugins/10-jq.sh) | Themed `JQ_COLORS` |
| `gh`, `helm`, `kubectl`, `npm`, `podman` | [`plugins/30-gh.sh`](./plugins/30-gh.sh), [`plugins/10-helm.sh`](./plugins/10-helm.sh), [`plugins/10-kubectl.sh`](./plugins/10-kubectl.sh), [`plugins/30-npm.sh`](./plugins/30-npm.sh), [`plugins/80-podman.sh`](./plugins/80-podman.sh) | Cached completion setup |
| `less` | [`plugins/10-less.sh`](./plugins/10-less.sh), [`plugins/10-lesspipe.sh`](./plugins/10-lesspipe.sh) | `LESS`, `MANPAGER`, `LESS_TERMCAP_*`, `less` alias, and cached `lesspipe` integration |
| `mysql` | [`plugins/30-mysql.sh`](./plugins/30-mysql.sh) | Custom `MYSQL_PS1` and pager alias |
| `nvm` | [`plugins/20-nvm.sh`](./plugins/20-nvm.sh) | Lazy loading plus cached default-node PATH setup |
| `ripgrep` | [`plugins/10-ripgrep.sh`](./plugins/10-ripgrep.sh), [`config/ripgrep/config`](./config/ripgrep/config) | Smart-case, hidden files, common exclusions, max column width, loaded via `RIPGREP_CONFIG_PATH` |
| `tmux` | [`dotenv/tmux/extra.sh`](./dotenv/tmux/extra.sh), [`tmux.conf`](./tmux.conf), [`config/tmux/`](./config/tmux) | Reloads exported tmux env vars at each prompt and syncs per-pane cwd into tmux for status integrations such as Powerline |
| `wget` | top-level [`wgetrc`](./wgetrc) | Repo-managed wget defaults via installed `~/.wgetrc` |
| `zoxide` | [`plugins/10-zoxide.sh`](./plugins/10-zoxide.sh) | `z` and `zi` shell integration |

## Core shell interface

### Core aliases

These aliases are available in interactive shells without enabling the full built-in plugin set.

| Name | Availability | Description |
| --- | --- | --- |
| `..`, `...`, `....`, `~`, `-` | always | directory shortcuts; `-` is `cd -` |
| `dir`, `vdir` | GNU `ls` only | vertical and long-format `ls` helpers |
| `extip` | always | print the current public IP via `api.ipify.org` |
| `grep`, `fgrep`, `egrep` | when the local `grep` supports `--color=auto` | colorized grep; `fgrep`/`egrep` use `grep -F`/`grep -E` |
| `h` | always | `history` |
| `ls`, `la`, `ll`, `l.` | when the local `ls` supports color | colorized listings |
| `o`, `oo` | always | open a path, or the current directory, with the platform `open` command |
| `reload` | always | `exec "${SHELL}" -l` |
| `rm`, `cp`, `mv` | always | interactive by default (`-i`) |
| `sudo` | always | trailing-space alias so aliases still expand after `sudo` |
| `totime`, `fromtime` | always | aliases to `date2unix` and `unix2date` |
| `vi` | always | best available editor from `internal::find-editor` |
| `which` | when `/usr/bin/which` supports `--tty-only` alias expansion | show aliases and expanded paths when possible |
| `x` | always | alias to `parallel-xargs` |

### Core shell functions

| Name | Availability | Description |
| --- | --- | --- |
| `binarydiff FILE1 FILE2` | always | compare two binaries via `vimdiff` and `xxd` |
| `cf [DIR]` | always | count regular files under `DIR` recursively |
| `codepoint CHAR` | always | print a Unicode code point like `U+03BB` |
| `curl-gz URL...` | always | request gzip content and pipe through `gunzip` |
| `dataurl FILE` | always | emit a `data:image/...;base64,...` URL using `openssl` |
| `date2unix [DATE...]` | always | parse a date string to Unix seconds; uses GNU `date`, `gdate`, or BSD fallbacks |
| `dotfiles-profile` | always | profile interactive shell startup; `--trace` requires Bash 5+ |
| `dotfiles-prompt-profile` | always | profile prompt render time in the current shell; requires interactive `PS1`, Bash 4.4+, and Bash 5+ for `--trace` |
| `dotfiles-update` | always | `git pull origin master` in `${DOTFILES__ROOT}/.dotfiles`, then run [`./bootstrap.sh`](./bootstrap.sh) |
| `escape` | always | emit UTF-8 bytes as `\xNN` escapes |
| `extract FILE` | always | extract archives by extension (`tar.gz`, `tar.xz`, `zip`, `7z`, `rar`, `zst`, and others) |
| `gdiff FILE1 FILE2` | when `git` is installed | `git diff --no-index --color` wrapper |
| `gz-size FILE` | always | print original and gzipped byte counts |
| `lc` | always | lowercase stdin |
| `md DIR` | always | `mkdir -p` and `cd` into the target |
| `parallel-xargs CMD [ARG...]` | always | `xargs -P "${PROC_CORES}"` wrapper; inserts `{}` if you did not provide it |
| `regex PATTERN [GROUP]` | always | `gawk` regex matcher/capture helper |
| `uc` | always | uppercase stdin |
| `unidecode STRING` | always | decode `\x{ABCD}`-style Unicode escapes |
| `unix2date [TS]` | always | convert a Unix timestamp to a local date string |

### Platform-specific shell functions and aliases

| Name | Platform | Description |
| --- | --- | --- |
| `cmd0` | WSL | run a command through `cmd.exe /c` and strip CRLF endings |
| `ips` | Linux, macOS | print bound IPv4 addresses |
| `wudo`, `wsl-sudo` | WSL | aliases to `winsudo` |

## Built-in plugin interface

Unless noted otherwise, everything in this section requires `DOT_INCLUDE_BUILTIN_PLUGINS=1` before startup.

| Interface | Requires | Description |
| --- | --- | --- |
| `bat` | [`plugins/30-bat.sh`](./plugins/30-bat.sh), `batcat` but not `bat` | alias `bat` to `batcat` on Debian-family installs |
| `cat` | [`plugins/30-bat.sh`](./plugins/30-bat.sh), `bat` or `batcat` | alias to `bat --paging=never` |
| `cd` | [`plugins/00-cd.sh`](./plugins/00-cd.sh) | replaces `cd` with a directory-stack-aware version; `cd --` shows `dirs -v`, `cd -N` jumps to a stack entry, and the stack keeps the current directory plus up to 10 previous entries |
| `cdnvm` | [`plugins/20-nvm.sh`](./plugins/20-nvm.sh), `nvm` installed | `chpwd` helper that auto-runs `nvm use` based on `.nvmrc` or the default alias |
| `docker`, `docker-compose` | [`plugins/80-podman.sh`](./plugins/80-podman.sh) and/or [`plugins/90-docker.sh`](./plugins/90-docker.sh) | wrapper functions/aliases that prefer Docker when a daemon is available, otherwise Podman; `docker-compose` also falls back to `docker compose` when needed |
| `fd` | [`plugins/10-fd.sh`](./plugins/10-fd.sh), `fd` or `fdfind` with `--hyperlink` support | alias `fd` to `{fd,fdfind} --hyperlink=auto`; falls back to plain `fdfind` alias when hyperlinks are unsupported |
| `findhere` | [`plugins/10-fd.sh`](./plugins/10-fd.sh), `fd` or `fdfind` | run the configured fd command with `--hidden --follow` in the current tree |
| `kc` | [`plugins/10-kubectl.sh`](./plugins/10-kubectl.sh), `kubectl` | alias to `kubectl` with lazy completion |
| `less` | [`plugins/10-less.sh`](./plugins/10-less.sh) | alias to `less -FRX` |
| `ls`, `la`, `ll`, `l.`, `lt` | [`plugins/10-eza.sh`](./plugins/10-eza.sh), `eza` | override listing aliases to use `eza`; `lt` is a two-level tree view |
| `mysql` | [`plugins/30-mysql.sh`](./plugins/30-mysql.sh), `mysql` | alias with line numbers, pager, warnings, and UTF-8 defaults |
| `nvm`, `node`, `npm`, `npx` | [`plugins/20-nvm.sh`](./plugins/20-nvm.sh), `nvm` installed | lazy wrappers that source `nvm.sh` on first use when `nvm` is not already on `PATH` |
| `nvm-upgrade` | [`plugins/20-nvm.sh`](./plugins/20-nvm.sh), `nvm` installed from git | check out the latest tagged `nvm` release |
| `podman-wsl2-fix-mount` | [`plugins/80-podman.sh`](./plugins/80-podman.sh), `podman`, WSL2 | helper that runs `sudo mount --make-rshared /` when rootless Podman needs it |
| `z`, `zi` | [`plugins/10-zoxide.sh`](./plugins/10-zoxide.sh), `zoxide` | directory-jump commands generated by `zoxide init bash` |

## Commands on PATH

### Utility commands

| Command | Platforms | Description |
| --- | --- | --- |
| [`chattr`](./dotenv/wsl/bin/chattr) | WSL | wrap Windows `attrib.exe` |
| [`clipboard-server`](./dotenv/bin/clipboard-server) | all | Node-based clipboard bridge with `start`, `stop`, `restart`, and foreground `server` modes |
| [`fswatch`](./dotenv/linux/bin/fswatch) | Linux | watch a directory with `inotifywait` and rerun a command |
| [`genpasswd`](./dotenv/bin/genpasswd) | all | generate random passwords or tokens |
| [`is-elevated-session`](./dotenv/wsl/bin/is-elevated-session) | WSL | exit successfully when the current Windows session is elevated |
| [`mklink`](./dotenv/wsl/bin/mklink) | WSL | wrap Windows `mklink` with `ln`-style arguments |
| [`npp`](./dotenv/wsl/bin/npp) | WSL | open Notepad++ with WSL path translation; falls back to a terminal editor if unavailable |
| `open` | Linux, WSL | open paths or URLs with the native platform handler; see [`dotenv/linux/bin/open`](./dotenv/linux/bin/open) and [`dotenv/wsl/bin/open`](./dotenv/wsl/bin/open) |
| `pbcopy` | Linux, WSL, SSH | copy stdin to the clipboard; see [`dotenv/linux/bin/pbcopy`](./dotenv/linux/bin/pbcopy), [`dotenv/wsl/bin/pbcopy`](./dotenv/wsl/bin/pbcopy), and [`dotenv/ssh/bin/pbcopy`](./dotenv/ssh/bin/pbcopy); SSH uses [`clipboard-server`](./dotenv/bin/clipboard-server) first and falls back to the local implementation |
| `pbpaste` | Linux, WSL, SSH | read clipboard contents to stdout; see [`dotenv/linux/bin/pbpaste`](./dotenv/linux/bin/pbpaste), [`dotenv/wsl/bin/pbpaste`](./dotenv/wsl/bin/pbpaste), and [`dotenv/ssh/bin/pbpaste`](./dotenv/ssh/bin/pbpaste); SSH uses [`clipboard-server`](./dotenv/bin/clipboard-server) first and falls back to the local implementation |
| `quick-toast` | Linux, macOS, WSL | show a desktop notification; see [`dotenv/darwin/bin/quick-toast`](./dotenv/darwin/bin/quick-toast), [`dotenv/linux/bin/quick-toast`](./dotenv/linux/bin/quick-toast), and [`dotenv/wsl/bin/quick-toast`](./dotenv/wsl/bin/quick-toast) |
| [`winrun`](./dotenv/wsl/bin/winrun) | WSL | run a Windows command through `cmd.exe /c` with path translation |
| [`winstart`](./dotenv/wsl/bin/winstart) | WSL | launch files or programs with Windows `Start-Process` |
| [`winsudo`](./dotenv/wsl/bin/winsudo) | WSL | elevate Windows commands; prefers native `sudo.exe` inline mode and falls back to an SSH-based helper |
| [`winwhoami`](./dotenv/wsl/bin/winwhoami) | WSL | print the Windows username for the current session |
| [`wusbipd`](./dotenv/wsl2/bin/wusbipd) | WSL2 | run Windows `usbipd.exe` through `winsudo` |

### Git subcommands

These come from executables in [`dotenv/bin/`](./dotenv/bin) named `git-*`.
In this repo, [`git ignore`](./dotenv/bin/git-ignore) resolves to the `git-ignore` executable even though [`config/git/alias.gitconfig.conf`](./config/git/alias.gitconfig.conf) also defines an `ignore` alias.

| Command | Description |
| --- | --- |
| [`git branch-prune`](./dotenv/bin/git-branch-prune) | delete branches already merged into the default branch and prune them from `origin` |
| [`git changelog`](./dotenv/bin/git-changelog) | print commits since the latest tag, or prepend a new changelog header to a file |
| [`git cherry-pick-from`](./dotenv/bin/git-cherry-pick-from) | cherry-pick a commit from another repository, optionally restricted to paths |
| [`git default-branch`](./dotenv/bin/git-default-branch) | print the repository default branch |
| [`git ignore`](./dotenv/bin/git-ignore) | show or append entries in the local or global gitignore |
| [`git ls-dir`](./dotenv/bin/git-ls-dir) | list files in a tree together with the most recent commit that touched each file |
| [`git ssh-socks-proxy`](./dotenv/bin/git-ssh-socks-proxy) | wrap `ssh` and derive a `ProxyCommand` from git config |
| [`git sync`](./dotenv/bin/git-sync) | update the default branch from `origin` or `upstream`, then restore the starting branch and dirty state |
| [`git undo-index`](./dotenv/bin/git-undo-index) | discard tracked changes while storing an undo commit in the reflog |

[`git-diff-highlight`](./dotenv/bin/git-diff-highlight) is also shipped in [`dotenv/bin/`](./dotenv/bin) and is used by the default git pager configuration when `delta` is not active.

## Git aliases

Git aliases are defined in [`config/git/alias.gitconfig.conf`](./config/git/alias.gitconfig.conf).

### Basic

| Alias | Description |
| --- | --- |
| `git br` | `git branch` |
| `git cl` | `git clone --recursive` |
| `git co` | `git checkout` |
| `git cp` | `git cherry-pick` |
| `git cp-from` | alias to `git cherry-pick-from` |
| `git df` | `git diff` |
| `git git` | no-op shell-out alias used so other shell aliases can call `git` consistently |
| `git lg` | `git log -p` |
| `git st` | `git status` |

### Stashing and inspection

| Alias | Description |
| --- | --- |
| `git branches` | `git branch -a` |
| `git remotes` | `git remote -v` |
| `git sa` | `git stash apply` |
| `git si` | `git stash --keep-index` |
| `git sl` | `git stash list` |
| `git snapshot` | create a dated stash snapshot, then re-apply it |
| `git sp` | `git stash pop` |
| `git ss` | `git stash` |
| `git tags` | `git tag -l` |

### Adding and file state

| Alias | Description |
| --- | --- |
| `git assume` | mark paths assume-unchanged |
| `git assumed` | list assume-unchanged paths |
| `git au` | `git add -u -- .` |
| `git rml` | `git rm --cached` |
| `git unassume` | clear assume-unchanged on paths |

### Commit helpers

| Alias | Description |
| --- | --- |
| `git aca` | `git add -A && git commit` |
| `git acam` | `git add -A && git commit -m` |
| `git amend` | amend the previous commit with the same subject line |
| `git asquish` | `git add -A && git commit --amend -C HEAD` |
| `git ca` | `git commit -a` |
| `git cam` | `git commit -a -m` |
| `git ci` | `git commit` |
| `git cia` | `git commit --amend` |
| `git ciam` | `git commit --amend -m` |
| `git cim` | `git commit -m` |
| `git squeeze` | amend the previous commit using only staged changes |
| `git squish` | amend the previous commit with tracked changes |

### Branching and rebasing

| Alias | Description |
| --- | --- |
| `git branch-root` | print the merge-base of the current branch and the default branch |
| `git brn` | print the current branch name |
| `git brt` | alias to `git branch-root` |
| `git cb` | create a branch or check it out if it already exists |
| `git col` | `git checkout -` |
| `git com` | check out the default branch |
| `git go` | `git checkout -B` |
| `git ours` | check out `--ours` for paths, then `git add` them |
| `git rb` | `git rebase` |
| `git rba` | `git rebase --abort` |
| `git rbc` | `git rebase --continue` |
| `git rbi` | `git rebase -i` |
| `git rbim` | interactive rebase on the default branch |
| `git rbm` | rebase the current branch on the default branch |
| `git rbs` | `git rebase --skip` |
| `git theirs` | check out `--theirs` for paths, then `git add` them |
| `git trunk` | print the default branch via `git-default-branch` |
| `git ubo` | pull the current branch from `origin` |

### Resetting and recovery

| Alias | Description |
| --- | --- |
| `git uncommit` | `git reset --soft HEAD^` |
| `git undo` | alias to `git undo-index` |
| `git undo-filemode` | revert file mode changes only |
| `git unstage` | `git reset HEAD --` |

### Logs, search, and diffs

| Alias | Description |
| --- | --- |
| `git dfl` | `git log -p --ext-diff` with `diff.external=difft` |
| `git dfs` | `git show --ext-diff` with `diff.external=difft` |
| `git dft` | `git diff` with `diff.external=difft` |
| `git diffall` | open `git difftool` on every changed file in the background |
| `git l` | one-line decorated graph log |
| `git rsearch` | `git log -p -G` |
| `git search` | `git log -p -S` |
| `git tree` | compact all-branches graph log |

### Syncing, pushing, and submodules

| Alias | Description |
| --- | --- |
| `git p` | pull the repo, then pull each submodule from its default branch |
| `git pm` | check out the default branch and pull it from `origin` |
| `git pob` | push the current branch to `origin` with the same branch name |
| `git ps` | pull the repo, then recursively update submodules |
| `git subi` | `git submodule update --init` |
| `git subu` | `git submodule update` |
| `git undopush` | force-push `HEAD^` to the default branch on `origin` |

### Miscellaneous and GitHub helpers

| Alias | Description |
| --- | --- |
| `git add-unmerged` | `git add` every unmerged path |
| `git edit-unmerged` | open unmerged paths in `${EDITOR:-vi}` |
| `git hub` | `gh browse` |
| `git hub-url` | open the GitHub page for a commit |
| `git ignore` | legacy config alias that is shadowed at runtime by the `git-ignore` executable |
| `git lost` | show dangling commits from `git fsck` |
| `git pr` | `gh pr create --web` |
| `git pr-get` | `gh pr checkout` |
| `git pulley` | fetch a remote branch into a temporary branch, squash-merge it into the default branch, and commit |

## Hooks and extension points

### Shell hooks

| Interface | Description |
| --- | --- |
| `chpwd` / `chpwd_functions` | run when `$PWD` changes before the next prompt |
| `precmd` / `precmd_functions` | run just before each prompt |
| `preexec` / `preexec_functions` | run after a command line is read and before the command executes |

Notes:

- `precmd` and `preexec` depend on [`external/bash-preexec.sh`](./external/bash-preexec.sh) and are skipped when `DOT_DISABLE_PREEXEC=1`.
- `chpwd` support comes from [`plugins/00-chpwd-hook.sh`](./plugins/00-chpwd-hook.sh), which is one of the two built-ins loaded by default.

Example:

```bash
# ~/.bash_local
chpwd() {
  printf 'cwd: %s\n' "$PWD"
}

preexec() {
  __dot_last_command="$1"
}

precmd() {
  unset __dot_last_command
}
```

Multiple shell hooks can also be appended through the matching arrays:

```bash
log_pwd() {
  printf 'cwd: %s\n' "$PWD"
}

refresh_history() {
  history -a
}

chpwd_functions+=(log_pwd)
precmd_functions+=(refresh_history)
```

### Phase hooks

For each phase below, you can define either a singular function or append functions to the matching array.

| Phase | Singular functions | Array hooks |
| --- | --- | --- |
| `exports` | `dotfiles_hook_exports_pre`, `dotfiles_hook_exports_post` | `dotfiles_hook_exports_pre_functions`, `dotfiles_hook_exports_post_functions` |
| `functions` | `dotfiles_hook_functions_pre`, `dotfiles_hook_functions_post` | `dotfiles_hook_functions_pre_functions`, `dotfiles_hook_functions_post_functions` |
| `aliases` | `dotfiles_hook_aliases_pre`, `dotfiles_hook_aliases_post` | `dotfiles_hook_aliases_pre_functions`, `dotfiles_hook_aliases_post_functions` |
| `extra` | `dotfiles_hook_extra_pre`, `dotfiles_hook_extra_post` | `dotfiles_hook_extra_pre_functions`, `dotfiles_hook_extra_post_functions` |
| `env` | `dotfiles_hook_env_pre`, `dotfiles_hook_env_post` | `dotfiles_hook_env_pre_functions`, `dotfiles_hook_env_post_functions` |
| `completion` | `dotfiles_hook_completion_pre`, `dotfiles_hook_completion_post` | `dotfiles_hook_completion_pre_functions`, `dotfiles_hook_completion_post_functions` |
| `plugin` | `dotfiles_hook_plugin_pre`, `dotfiles_hook_plugin_post` | `dotfiles_hook_plugin_pre_functions`, `dotfiles_hook_plugin_post_functions` |
| `prompt` | `dotfiles_hook_prompt_pre`, `dotfiles_hook_prompt_post` | `dotfiles_hook_prompt_pre_functions`, `dotfiles_hook_prompt_post_functions` |

After the full shell setup completes, `dotfiles_complete` and `dotfiles_complete_functions` run once.

Example:

```bash
# ~/.bash_local
dotfiles_hook_exports_pre() {
  export FOO=123
}

add_alias_examples() {
  alias curl-help='curl --help'
}

dotfiles_hook_aliases_post_functions+=(add_alias_examples)
```

### Supported helper functions

This reference treats the following `internal::...` helpers as extension surface for local overrides. Other `internal::...` functions are implementation detail.

| Function | Description |
| --- | --- |
| `internal::path-push [--prepend] DIR` | add a directory to `PATH` if it exists and is not already present |
| `internal::prompt-action-push CMD` | add `CMD` to the internal prompt action stack executed by `internal::prompt-action-run` |
| `internal::prompt-command-push CMD` | append `CMD` to `PROMPT_COMMAND` while de-duplicating existing entries |

## Environment variables

### Runtime exports

| Variable | Availability | Description |
| --- | --- | --- |
| `BASH_SILENCE_DEPRECATION_WARNING` | macOS only | suppress the macOS Bash deprecation banner |
| `BROWSER` | WSL only | defaults to `winstart` |
| `COLORTERM` | most terminals | set to `truecolor` for `*-256color`, `alacritty`, `xterm-kitty`, `xterm-ghostty` when not already set |
| `DOTENV` | always | `linux` or `darwin` |
| `DOTFILES__ARCH` | always | result of `uname -m` |
| `DOTFILES__CONFIG_DIR` | always | config/cache root, default `${XDG_CONFIG_HOME:-$HOME/.config}/dotfiles` |
| `DOTFILES__ROOT` | always | install root used to find `${DOTFILES__ROOT}/.dotfiles` |
| `DOT___IS_SCREEN` | screen only | readonly flag set to `1` inside GNU screen |
| `DOT___IS_SSH` | SSH only | readonly flag set to `1` in SSH sessions |
| `DOT___IS_WSL` | WSL only | readonly flag set to `1` inside WSL |
| `DOT___IS_WSL2` | WSL2 only | readonly flag set to `1` inside WSL2 |
| `EDITOR` | always | best available editor from `internal::find-editor` unless already set |
| `LC_ALL`, `LANG` | always | locale defaults set to `en_US.UTF-8` |
| `PAGER` | always | defaults to `less` unless already set |
| `PROC_CORES` | Linux, macOS | CPU count used by helpers such as `parallel-xargs` |
| `VISUAL` | always | defaults to `${EDITOR}` unless already set |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` | always | XDG base-directory defaults |

The loader upgrades `TERM` to a 256-color variant for `xterm*`, `rxvt*`, and `screen*` sessions, and sets `COLORTERM=truecolor` for terminals known to support 24-bit color (any `*-256color` variant, `alacritty`, `xterm-kitty`, `xterm-ghostty`) when the variable is not already set by the terminal emulator.

### Prompt runtime exports

| Variable | Description |
| --- | --- |
| `GIT_PS1_SHOWDIRTYSTATE` | enabled |
| `GIT_PS1_SHOWSTASHSTATE` | enabled |
| `GIT_PS1_SHOWUNTRACKEDFILES` | enabled |
| `GIT_PS1_SHOWUPSTREAM` | set to `auto` |
| `PS1` | generated interactive prompt |
| `PS2` | secondary prompt, configurable via `DOT_PS2`, defaults to `→ ` |
| `PS4` | debug/trace prompt, configurable via `DOT_PS4`, defaults to `+ ${BASH_SOURCE}:${LINENO} ${FUNCNAME}(): ` |
| `SUDO_PS1` | prompt string used for sudo shells |

### Completion-related exports

| Variable | Description |
| --- | --- |
| `COMP_CONFIGURE_HINTS=1` | keep `--option=description` style hints for `./configure --help` completion |
| `COMP_CVS_REMOTE=1` | allow remote CVS completion |
| `COMP_TAR_INTERNAL_PATHS=1` | keep internal tar paths during completion |
| `COMP_WORDBREAKS` | modified to remove `=` as a word break |

### Startup configuration variables

Set these before the dotfiles are sourced, usually in `~/.bash_local`.

| Variable | Default | Effect |
| --- | --- | --- |
| `BASHRC_NONINTERACTIVE_BYPASS` | unset | allow `bashrc.sh` to continue loading in non-interactive shells |
| `DOT_AUTOLOAD_SSH_AGENT` | unset | when the SSH plugin is enabled, auto-start or reuse `ssh-agent` |
| `DOT_BASH_RESOLVE_PATHS` | unset | enable `set -o physical` so `cd` does not follow symlink chains |
| `DOT_DISABLE_HYPERLINKS` | unset | suppress OSC 8 terminal hyperlinks emitted by `ls`, `eza`, `rg`, `fd`, and `delta`; hyperlinks are auto-suppressed over SSH unless a VS Code-family terminal is detected; tmux still advertises hyperlink support to the outer terminal |
| `DOT_HYPERLINK_SCHEME` | unset | override the auto-detected editor terminal; when running inside a VS Code, Cursor, or VS Code Insiders integrated terminal the value is detected automatically (`vscode`, `cursor`, or `vscode-insiders`) and used to relax the default SSH hyperlink suppression since the editor terminal can resolve `file://` paths through the remote connection |
| `DOT_HYPERLINK_SSH_HOST` | unset | set to the VS Code SSH remote name (the `Host` alias from `~/.ssh/config`) to enable `{scheme}://vscode-remote/ssh-remote+{host}` hyperlinks in `rg` and `delta`; on WSL the distro name is detected automatically via `WSL_DISTRO_NAME` so this variable is only needed for SSH remotes |
| `DOT_DISABLE_PREEXEC` | unset | skip sourcing [`external/bash-preexec.sh`](./external/bash-preexec.sh) |
| `DOT_INCLUDE_BREW_PATH` | unset | on macOS, prepend Homebrew `bin`, `sbin`, and GNU `gnubin` paths, and extend `MANPATH` |
| `DOT_INCLUDE_BUILTIN_PLUGINS` | unset | load the full built-in [`plugins/*.sh`](./plugins) set instead of only [`00-bash-opts.sh`](./plugins/00-bash-opts.sh) and [`00-chpwd-hook.sh`](./plugins/00-chpwd-hook.sh) |
| `DOT_PLUGIN_DISABLE_<name>` | unset | disable one built-in plugin or local `.plugin` file; leading numeric ordering prefixes are stripped before the disable name is derived |
| `DOT_SOLARIZED_DARK` | unset | choose Solarized Dark where theme-aware plugins support it |
| `DOT_SOLARIZED_LIGHT` | unset | choose Solarized Light where theme-aware plugins support it |

### Prompt configuration variables

Set these before prompt setup, typically in `~/.bash_local`. They are consumed during prompt initialization and then unset.

#### Segment lists

| Variable | Default | Description |
| --- | --- | --- |
| `DOT_PS1_SEGMENTS` | `(exit_status bg_jobs time loadavg user session_host workdir dirinfo git exec_time)` | ordered array of segment names for `PS1` |
| `DOT_SUDO_PS1_SEGMENTS` | `(exit_status bg_jobs time user session_host workdir)` | ordered array of segment names for `SUDO_PS1` |

Override the entire list or use the segment helpers to add/remove individual segments.

#### Prompt options

| Variable | Default | Description |
| --- | --- | --- |
| `DOT_DISABLE_PS1` | unset | skip prompt setup entirely |
| `DOT_GIT_PROMPT_CACHE_MAX_AGE_MS` | `10000` | maximum age before forcing a full `__git_ps1` refresh |
| `DOT_GIT_PROMPT_CACHE_TTL_MS` | `1000` | per-directory TTL before the git prompt checks repo state again |
| `DOT_GIT_PROMPT_INVALIDATE_ON_GIT` | `1` | when `1`, mark the git prompt cache dirty after git-like commands |
| `DOT_PS1_TITLE` | unset | terminal title override; when unset, a terminal-specific default is used (`PROMPT_TITLE` is accepted as a fallback) |
| `DOT_PS1_DAY_END` | `18` | hour when daytime coloring ends |
| `DOT_PS1_DAY_START` | `8` | hour when daytime coloring starts |
| `DOT_PS1_MONOCHROME` | unset | remove prompt colors |
| `DOT_PS1_MULTILINE` | unset | always put the prompt symbol on its own line |
| `DOT_PS1_NEWLINE_THRESHOLD` | `120` | terminal width below which the prompt wraps to a new line |
| `DOT_PS2` | `→ ` | continuation prompt (PS2) |
| `DOT_PS4` | `+ ${BASH_SOURCE}:${LINENO}...` | debug/trace prompt (PS4) |

Example:

```bash
# ~/.bash_local
DOT_PS1_TITLE='work-shell'
DOT_PS1_NEWLINE_THRESHOLD=100
DOT_PS1_SYMBOL_USER='>'
internal::ps1-segment-remove loadavg
```

#### Prompt segment helpers

| Function | Description |
| --- | --- |
| `internal::ps1-segment-add <name> [--before <ref>\|--after <ref>] [--sudo]` | insert a segment into the segment list |
| `internal::ps1-segment-remove <name> [--sudo]` | remove a segment from the segment list |
| `internal::ps1-rebuild` | rebuild `PS1` and `SUDO_PS1` from the current segment lists at runtime |

#### Prompt symbol overrides

| Variable | Default | Description |
| --- | --- | --- |
| `DOT_PS1_SYMBOL_GIT` | `կ` | git branch prefix; rendered bold with a trailing space |
| `DOT_PS1_SYMBOL_LOCAL` | `#` | separator between user and host in local sessions |
| `DOT_PS1_SYMBOL_NO_WRITE_PWD` | `*` | marker for non-writable directories |
| `DOT_PS1_SYMBOL_ROOT` | `μ` | root prompt symbol |
| `DOT_PS1_SYMBOL_SSH` | `@` | separator between user and host in SSH sessions |
| `DOT_PS1_SYMBOL_SU` | `π` | sudo shell prompt symbol |
| `DOT_PS1_SYMBOL_USER` | `λ` | normal user prompt symbol |
| `DOT_PS1_SYMBOL_WIN_PRIV` | `W*` | elevated Windows session marker under WSL |

#### Prompt color overrides

| Variable | Description |
| --- | --- |
| `DOT_PS1_COLOR_BG_JOBS` | background job count color |
| `DOT_PS1_COLOR_EXEC_TIME` | last-command duration color |
| `DOT_PS1_COLOR_EXIT_ERROR` | non-zero exit code color |
| `DOT_PS1_COLOR_GIT` | git segment color |
| `DOT_PS1_COLOR_GREY` | bracket color |
| `DOT_PS1_COLOR_HOST` | hostname color |
| `DOT_PS1_COLOR_HOST_SCREEN` | host/screen-session color |
| `DOT_PS1_COLOR_LOAD` | load-average color array |
| `DOT_PS1_COLOR_TIME_DAY` | daytime clock color |
| `DOT_PS1_COLOR_TIME_NIGHT` | nighttime clock color |
| `DOT_PS1_COLOR_USER` | username color |
| `DOT_PS1_COLOR_WORK_DIR` | working directory color |
| `DOT_PS1_COLOR_WORK_DIRINFO` | directory count/size color |

See [`PROMPT.md`](./PROMPT.md) for prompt screenshots and the default color values.

### Plugin-exported defaults

These variables are only relevant when the matching built-in plugin loads.

| Plugin | Variables | Description |
| --- | --- | --- |
| [`00-bash-opts.sh`](./plugins/00-bash-opts.sh) | `HISTCONTROL`, `HISTIGNORE`, `HISTSIZE`, `HISTFILESIZE`, `HISTTIMEFORMAT`, `CDPATH` | history and navigation defaults |
| [`00-direnv.sh`](./plugins/00-direnv.sh) | `DIRENV_LOG_FORMAT` | silence direnv log chatter |
| [`00-brew.sh`](./plugins/00-brew.sh) | `MANPATH` | prepend Homebrew and GNU manpage paths |
| [`10-dircolors.sh`](./plugins/10-dircolors.sh) | `LS_COLORS` | Solarized `dircolors` theme when `DOT_SOLARIZED_LIGHT` or `DOT_SOLARIZED_DARK` is set |
| [`10-fzf.sh`](./plugins/10-fzf.sh) | `FZF_DEFAULT_COMMAND`, `FZF_CTRL_T_COMMAND`, `FZF_ALT_C_COMMAND`, `FZF_DEFAULT_OPTS`, `FZF_CTRL_T_OPTS`, `FZF_ALT_C_OPTS`, `FZF_CTRL_R_OPTS` | fzf defaults and previews |
| [`10-jq.sh`](./plugins/10-jq.sh) | `JQ_COLORS` | themed jq colors |
| [`10-less.sh`](./plugins/10-less.sh) | `MANPAGER`, `LESS`, `LESS_TERMCAP_mb`, `LESS_TERMCAP_md`, `LESS_TERMCAP_me`, `LESS_TERMCAP_se`, `LESS_TERMCAP_so`, `LESS_TERMCAP_ue`, `LESS_TERMCAP_us` | less and manpage defaults |
| [`10-ripgrep.sh`](./plugins/10-ripgrep.sh) | `RIPGREP_CONFIG_PATH` | point `rg` at [`config/ripgrep/config`](./config/ripgrep/config) |
| [`20-nvm.sh`](./plugins/20-nvm.sh) | `NVM_DIR` | nvm install root |
| [`30-bat.sh`](./plugins/30-bat.sh) | `BAT_CONFIG_PATH`, `BAT_THEME`, `MANPAGER`, `MANROFFOPT` | bat defaults and colored manpage integration |
| [`30-difftastic.sh`](./plugins/30-difftastic.sh) | `DFT_BACKGROUND`, `DFT_DISPLAY`, `DFT_TAB_WIDTH`, `DFT_PARSE_ERROR_LIMIT` | difftastic defaults |
| [`30-mysql.sh`](./plugins/30-mysql.sh) | `MYSQL_PS1` | custom MySQL client prompt |
| [`30-npm.sh`](./plugins/30-npm.sh) | `NPM_CONFIG_PREFIX`, `MANPATH`, `OPEN_SOURCE_CONTRIBUTOR` | npm global install path and default env tweaks |
| [`80-podman.sh`](./plugins/80-podman.sh) | `BUILDAH_FORMAT` | default Podman/Buildah image format |
| [`90-docker.sh`](./plugins/90-docker.sh) | `COMPOSE_HTTP_TIMEOUT`, `HISTIGNORE` | longer Compose timeout and extra history ignores |

### Command-specific environment variables

| Variable | Used by | Description |
| --- | --- | --- |
| `CLIPBOARD_SERVER_PORT` | SSH [`pbcopy`](./dotenv/ssh/bin/pbcopy) / [`pbpaste`](./dotenv/ssh/bin/pbpaste), [`clipboard-server`](./dotenv/bin/clipboard-server) | forwarded TCP port for remote clipboard access |
| `CLIPBOARD_SERVER_SOCK` | SSH [`pbcopy`](./dotenv/ssh/bin/pbcopy) / [`pbpaste`](./dotenv/ssh/bin/pbpaste), [`clipboard-server`](./dotenv/bin/clipboard-server) | forwarded Unix socket path; defaults to `/tmp/clipboard-server.sock` |
| `GIT_SSH_NO_PROXY` | [`git ssh-socks-proxy`](./dotenv/bin/git-ssh-socks-proxy) | comma-separated host list that bypasses configured git SSH proxy rules |

## Troubleshooting

### Slow shell startup

If shell startup takes more than a second, common culprits include:

- `nvm`: when `DOT_INCLUDE_BUILTIN_PLUGINS=1`, the nvm plugin lazy-loads `nvm.sh` on first use. The default node version's bin dir is cached in `~/.config/dotfiles/cache/nvm_default_path` so `node`/`npm`/`npx` are available immediately. If the cache is missing, nvm is sourced once to seed it.
- completions: with the full built-in plugin set enabled, completion scripts for tools like `kubectl`, `helm`, `gh`, `npm`, and `podman` can add up. The repo caches generated completions where possible.
- prompt segments: the load-average and exec-timer segments spawn subprocesses on older Bash setups. Remove them with `internal::ps1-segment-remove loadavg` or `internal::ps1-segment-remove exec_time`.
- git prompt status: if `__git_ps1` is still slow in very large repos, increase `DOT_GIT_PROMPT_CACHE_TTL_MS` or `DOT_GIT_PROMPT_CACHE_MAX_AGE_MS`.
- local overrides: `~/.bash_local`, `~/.bash_local.d/*.sh`, `~/.bash_local.d/*.plugin`, and `dotfiles_complete()` can add significant local startup cost.

To profile startup time:

```bash
# quick overall timing
dotfiles-profile

# detailed per-command breakdown (bash 5+)
dotfiles-profile --trace

# hide noisy entries (regex)
dotfiles-profile --trace --exclude 'git-prompt|__git_ps1'

# prompt render timing in current shell (20 renders by default)
dotfiles-prompt-profile

# prompt render trace (bash 5+)
dotfiles-prompt-profile --trace --count 20

# prompt render trace excluding git prompt internals
dotfiles-prompt-profile --trace --count 20 --exclude 'git-prompt|__git_ps1'
```

### Prompt symbols display as boxes or question marks

The prompt uses UTF-8 symbols such as lambda, mu, pi, and the Armenian git marker. Your terminal and font must support Unicode. Nerd Font variants such as `JetBrainsMono Nerd Font` or `FiraCode Nerd Font` usually work well.

### `date2unix` does not parse a date

On macOS, `date2unix` first tries GNU-style parsing with `date --date`, then `gdate` from Homebrew, then BSD `date -j -f` fallbacks for a few common formats. Installing `coreutils` gives the broadest date parsing via `gdate`.

### Local overrides

Machine-specific configuration belongs in `~/.bash_local`, `~/.bash_local.d/*.sh`, and `~/.bash_local.d/*.plugin`. That keeps the repo itself portable while still letting you change startup behavior, env vars, hooks, and plugin loading locally.

## Additional tools

### clipboard-server

[`clipboard-server`](./dotenv/bin/clipboard-server) forwards local clipboard access over an HTTP socket. It is primarily intended for SSH sessions that want to use the local workstation clipboard remotely.

To start it locally:

```bash
clipboard-server start
# default socket: ~/.config/clipboard-server/clipboard-server.sock
```

To forward that socket over SSH as a TCP port:

```bash
ssh -R 127.0.0.1:29009:$HOME/.config/clipboard-server/clipboard-server.sock user@HOST
```

Or in `~/.ssh/config`:

```text
Host HOSTNAME
    RemoteForward 29009 /home/USERNAME/.config/clipboard-server/clipboard-server.sock
```

On the remote machine, point the SSH clipboard wrappers at the forwarded endpoint:

```bash
export CLIPBOARD_SERVER_PORT=29009

date | pbcopy
pbpaste | sed ...
```

If you forward a Unix socket instead of a TCP port, set `CLIPBOARD_SERVER_SOCK` instead.

## Notes

- Most standalone commands support `-h` or `--help`.
- [`README.md`](./README.md) covers installation and the customization model.
- [`PROMPT.md`](./PROMPT.md) covers prompt rendering details, screenshots, and color swatches.
