# weikinhuang's dotfiles reference <!-- omit in toc -->

- [Changes](#changes)
- [Tool Defaults](#tool-defaults)
- [New Global Variables](#new-global-variables)
- [All Platforms](#all-platforms)
  - [Navigation](#navigation)
  - [Directory Commands](#directory-commands)
  - [Shortcuts](#shortcuts)
- [Networking](#networking)
  - [String Manipulation](#string-manipulation)
  - [Utilities](#utilities)
  - [Git Utilities](#git-utilities)
- [Prompt Customization](#prompt-customization)
  - [Prompt Options](#prompt-options)
  - [Prompt Symbols](#prompt-symbols)
- [Windows Subsystem Linux (WSL) specific](#windows-subsystem-linux-wsl-specific)
  - [WSL Utilities](#wsl-utilities)
- [Bash hooks](#bash-hooks)
  - [Usage Examples](#usage-examples)
    - [When defined as a singular function](#when-defined-as-a-singular-function)
    - [Function Arrays](#function-arrays)
- [Troubleshooting](#troubleshooting)
  - [Slow shell startup](#slow-shell-startup)
  - [Prompt symbols display as boxes or question marks](#prompt-symbols-display-as-boxes-or-question-marks)
  - [`date2unix` doesn't work](#date2unix-doesnt-work)
  - [Local overrides](#local-overrides)
- [Additional tools](#additional-tools)
  - [clipboard-server](#clipboard-server)

## Changes

- `sudo` works on aliases
- `rm` `cp` `mv` are always interactive `-i` (use `-f` to override)
- `ls` and `grep` always has color (use `--color=never` to override)
- `which` command expands full path when possible
- `less` does not clear the screen upon exit and process colors (with options `-XR`)
- `vi` is aliased to the best available editor (`nvim` > `vim` > system default)
- `cat` is aliased to `bat --paging=never` when `bat` is installed (use `command cat` to bypass)
- `gdiff` uses git's diff command with color when possible
- `pbcopy` and `pbpaste` for cross-platform copy/paste from cli, and optionally over ssh
- `open` for cross-platform open in native application

## Tool Defaults

Plugins in `plugins/` configure sensible defaults for common tools when they're installed. All settings respect existing values — if you've already set an env var, it won't be overridden.

| Tool        | What's configured                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ripgrep** | Smart-case, hidden files, common glob exclusions (`.git`, `node_modules`, etc.), max column width. Config at `config/ripgrep/config`, loaded via `RIPGREP_CONFIG_PATH`. |
| **fzf**     | Reverse layout, 40% height, border, inline info. `CTRL-T` and `ALT-C` use `fd` when available. File preview via `bat`, directory preview via `tree`.                    |
| **bat**     | Line numbers + git changes style. Used as `MANPAGER` for colored man pages. `cat` aliased to `bat --paging=never`.                                                      |
| **delta**   | When installed, configured as the git pager with syntax highlighting and word-level diffs. Managed via `~/.config/dotfiles/git-delta.gitconfig`.                        |
| **less**    | Colored man pages via `LESS_TERMCAP_*`. Does not clear screen on exit (`-XR`).                                                                                          |
| **direnv**  | Silent log format, bash hook loaded automatically.                                                                                                                      |
| **eza**     | When installed, replaces `ls`/`la`/`ll`/`ld` aliases with git-aware, colorized equivalents. Adds `lt` for tree view.                                                    |
| **jq**      | Themed output colors via `JQ_COLORS`.                                                                                                                                   |
| **zoxide**  | Smart directory jumping via `z` and `zi` commands (frecency-based `cd` replacement).                                                                                    |
| **curl**    | Follow redirects, auto-referer, compressed responses, HTTPS default, 60s timeout, 3 retries.                                                                            |
| **wget**    | Timestamping, 60s timeout, 3 retries, retry on refused, modern user-agent string.                                                                                       |

Override any of these by setting the relevant env var in `~/.bash_local` before the dotfiles are sourced.

## New Global Variables

| ENV var                | Description                                                     |
| ---------------------- | --------------------------------------------------------------- |
| `DOT___IS_SCREEN`      | Set when the current environment is a screen session            |
| `DOT___IS_SSH`         | Set when the current environment is a ssh session               |
| `DOT___IS_WSL`         | Set when the current environment is running inside WSL          |
| `DOT___IS_WSL2`        | Set when the current environment is running inside WSL 2        |
| `DOTENV`               | Simple access to os platform (`darwin` or `linux`)              |
| `DOTFILES__ROOT`       | Root where dotfiles directory is installed (ex. `/home/ubuntu`) |
| `DOTFILES__CONFIG_DIR` | Config/cache directory (default `~/.config/dotfiles`)           |
| `EDITOR`               | Preferred editor, auto-detected if not set                      |
| `VISUAL`               | Visual editor, defaults to `$EDITOR`                            |
| `PAGER`                | Preferred pager, defaults to `less`                             |
| `PROC_CORES`           | Number of threads (cores)                                       |
| `XDG_CONFIG_HOME`      | XDG config directory (default `~/.config`)                      |
| `XDG_DATA_HOME`        | XDG data directory (default `~/.local/share`)                   |
| `XDG_STATE_HOME`       | XDG state directory (default `~/.local/state`)                  |
| `XDG_CACHE_HOME`       | XDG cache directory (default `~/.cache`)                        |

## All Platforms

### Navigation

| Command | Description                        |
| ------- | ---------------------------------- |
| `..`    | `cd ..`                            |
| `...`   | `cd ../..`                         |
| `....`  | `cd ../../..`                      |
| `~`     | `cd ~ == cd`                       |
| `-`     | `cd -`                             |
| `cd --` | List last 10 traversed directories |

### Directory Commands

| Command | Description                                                 |
| ------- | ----------------------------------------------------------- |
| `cf`    | Count the number of files in a directory                    |
| `grip`  | Alias for `grepdir` (when the `grip` tool is not installed) |
| `l.`    | Show files starting with `.`                                |
| `la`    | Show all files in list format                               |
| `ll`    | Show files in list format                                   |
| `lt`    | Tree view (2 levels deep, when `eza` is installed)          |
| `md`    | Create a new directory and enter it                         |

### Shortcuts

| Command | Description                                            |
| ------- | ------------------------------------------------------ |
| `-`     | `cd -`                                                 |
| `f`     | `findhere`                                             |
| `h`     | `history`                                              |
| `kc`    | `kubectl`                                              |
| `o`     | `open` (show in GUI file explorer)                     |
| `oo`    | `open .` (show cwd in GUI file explorer)               |
| `vi`    | Opens the best available editor                        |
| `x`     | `parallel-xargs`                                       |
| `z`     | Smart directory jump via zoxide (when installed)       |
| `zi`    | Interactive directory jump via zoxide (when installed) |

## Networking

| Command   | Description                         |
| --------- | ----------------------------------- |
| `curl-gz` | Make gzip enabled curl requests     |
| `extip`   | Get the current external ip address |
| `ips`     | Get all bound internal ips          |

### String Manipulation

| Command      | Description                                                                       |
| ------------ | --------------------------------------------------------------------------------- |
| `codepoint`  | Get a character's Unicode code point                                              |
| `escape`     | Escape UTF-8 characters into their 3-byte format (escape `λ` => `\xCE\xBB`)       |
| `lc`         | Convert to lowercase                                                              |
| `regex`      | Regex match and replace from [opsb/4409156](https://gist.github.com/opsb/4409156) |
| `uc`         | Convert to uppercase                                                              |
| `unidecode`  | Decode `\x{ABCD}`-style Unicode escape sequences                                  |
| `binarydiff` | Binary diff two files using `vimdiff` and `xxd`                                   |

### Utilities

| Command                                 | Description                                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `__push_internal_prompt_command`        | Pushes a new command to the internal stack to execute during `PROMPT_COMMAND`                         |
| `__push_path`                           | Pushes a new path to the `PATH` variable if directory exists (use `--prepend` to add to the front).   |
| `__push_prompt_command`                 | Pushes a new command to the `PROMPT_COMMAND` variable                                                 |
| [`clipboard-server`](#clipboard-server) | Forward local clipboard access over a socket                                                          |
| `dataurl`                               | Create a data URL from an image                                                                       |
| `date2unix`                             | Convert a date string to a unix timestamp (`date2unix Fri, Feb 13, 2009 6:31:30 PM` => `1234567890`)  |
| `dotfiles-profile`                      | Profile shell startup time (`--trace`, `--filter`, `--exclude` for breakdown; trace requires bash 5+) |
| `dotfiles-prompt-profile`               | Profile prompt render time in current shell (`--filter`/`--exclude` on trace; bash 4.4+, trace 5+)    |
| `dotfiles-update`                       | Pull latest changes and re-run `bootstrap.sh`                                                         |
| `extract`                               | Extracts an archive with autodetect based on extension (supports tar.xz, tar.zst, xz, zst, and more)  |
| `fromtime`                              | `unix2date`                                                                                           |
| `gdiff`                                 | Git-powered colored diff for comparing any two files (`gdiff file1 file2`)                            |
| `genpasswd`                             | Generate a random string of a certain length                                                          |
| `gz-size`                               | Get original and gzipped file size in bytes                                                           |
| `nvm-upgrade`                           | Upgrade nvm to the latest tagged release                                                              |
| `parallel-xargs`                        | Run a command through xargs in parallel without shell eval (`parallel-xargs cat {}`)                  |
| `quick-toast`                           | Show a simple notification using OS primitives `quick-toast TITLE [BODY]`                             |
| `reload`                                | Reload the current environment                                                                        |
| `totime`                                | `date2unix`                                                                                           |
| `unix2date`                             | Convert a unix timestamp to a date string (`unix2date 1234567890` => `Fri, Feb 13, 2009 6:31:30 PM`)  |

### Git Utilities

| Command                | Description                                                            |
| ---------------------- | ---------------------------------------------------------------------- |
| `git auto-difftool`    | Use araxis merge when possible otherwise use `vimdiff`                 |
| `git auto-mergetool`   | Use araxis merge when possible otherwise use `vimdiff`                 |
| `git branch-prune`     | Remove branches locally/remotely if already merged into default branch |
| `git changelog`        | Generate a changelog from git tags                                     |
| `git cherry-pick-from` | Cherry pick commits from a different git repo                          |
| `git default-branch`   | Print the repository default branch                                    |
| `git hooks`            | Execute a git hook                                                     |
| `git hub`              | Open the repo in the browser via `gh browse`                           |
| `git ignore`           | Add a file/path to .gitignore                                          |
| `git ls-dir`           | List files in a git repo tree together with the latest commit          |
| `git pr`               | Create a pull request on GitHub (opens web UI via `gh`)                |
| `git pr-get`           | Checkout a pull request locally via `gh`                               |
| `git repl`             | Start a repl where all commands are prefixed with `git`                |
| `git ssh-socks-proxy`  | Forward git SSH connections through a SOCKS proxy                      |
| `git sync`             | Sync origin with upstream remote                                       |
| `git touch`            | Make a new file and add it                                             |
| `git track`            | Sets up auto-tracking of a remote branch with same base name           |
| `git undo-index`       | Undo staged changes, storing them in the reflog                        |

## Prompt Customization

The prompt segments and appearance can be customized by setting variables in `~/.bash_local` **before** the dotfiles are sourced. All options are optional.

### Prompt Options

| Variable                           | Description                                                               | Default |
| ---------------------------------- | ------------------------------------------------------------------------- | ------- |
| `DOT_GIT_PROMPT_CACHE_TTL_MS`      | Skip re-checking git prompt state if last check is newer than this (ms)   | `1000`  |
| `DOT_GIT_PROMPT_CACHE_MAX_AGE_MS`  | Force a full `__git_ps1` refresh at least this often (ms)                 | `10000` |
| `DOT_GIT_PROMPT_INVALIDATE_ON_GIT` | Invalidate git prompt cache on the next prompt after git-related commands | `1`     |
| `DOT_DISABLE_PS1`                  | Skip prompt setup entirely                                                |         |
| `PS1_OPT_MONOCHROME`               | Disable all prompt colors                                                 |         |
| `PS1_OPT_MULTILINE`                | Always place the prompt symbol on a new line                              |         |
| `PS1_OPT_NEWLINE_THRESHOLD`        | Terminal width below which the prompt wraps to a new line                 | `120`   |
| `PS1_OPT_HIDE_TIME`                | Hide the clock segment                                                    |         |
| `PS1_OPT_HIDE_LOAD`                | Hide the load average segment                                             |         |
| `PS1_OPT_HIDE_DIR_INFO`            | Hide the directory file count / size segment                              |         |
| `PS1_OPT_HIDE_GIT`                 | Hide the git branch / status segment                                      |         |
| `PS1_OPT_HIDE_EXEC_TIME`           | Hide the command execution time segment                                   |         |
| `PS1_OPT_DAY_START`                | Hour (24h) when daytime color starts                                      | `8`     |
| `PS1_OPT_DAY_END`                  | Hour (24h) when daytime color ends                                        | `18`    |
| `PS1_OPT_SEGMENT_EXTRA`            | Arbitrary PS1 string appended after the git segment                       |         |

Set any `_HIDE_` variable to `1` to disable that segment. Example:

```bash
# ~/.bash_local
PS1_OPT_HIDE_LOAD=1
PS1_OPT_NEWLINE_THRESHOLD=100
```

### Prompt Symbols

Symbols can be overridden by setting these before sourcing:

| Variable           | Default | Description             |
| ------------------ | ------- | ----------------------- |
| `PS1_SYMBOL_USER`  | `λ`     | Normal user prompt      |
| `PS1_SYMBOL_ROOT`  | `μ`     | Root prompt             |
| `PS1_SYMBOL_SU`    | `π`     | Sudo prompt             |
| `PS1_SYMBOL_GIT`   | `կ`     | Git branch prefix       |
| `PS1_SYMBOL_SSH`   | `@`     | SSH session indicator   |
| `PS1_SYMBOL_LOCAL` | `#`     | Local session indicator |

All `PS1_COLOR_*` variables can also be overridden. See `dotenv/prompt.sh` for the full list.

## Windows Subsystem Linux (WSL) specific

### WSL Utilities

| Command               | Description                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `chattr`              | Change Windows file attributes                                                                                            |
| `cmd0`                | Run a command via the windows cmd prompt processor                                                                        |
| `is-elevated-session` | Check if the current shell is running with elevated Windows permissions                                                   |
| `mklink`              | Shortcut to the windows MKLINK command, with ln style args                                                                |
| `npp`                 | Open a sandboxed instance of notepad++                                                                                    |
| `winstart`            | Open/run a file using the native windows logic and associations                                                           |
| `winsudo`             | Run a process with elevated windows privileges. See [utils/wsl/README.md](./utils/wsl/README.md#winsudo-setup) for setup. |
| `wsl-sudo`            | Alias to `winsudo`                                                                                                        |
| `wudo`                | Alias to `winsudo`                                                                                                        |

## Bash hooks

Hooks with similar behavior to [**Zsh**](https://zsh.sourceforge.io/Doc/Release/Functions.html#Hook-Functions) are included for `chpwd`, `precmd`, and `preexec`.

`chpwd` hooks are setup with [00-chpwd-hook.sh](./plugins/00-chpwd-hook.sh).

`preexec` and `precmd` hooks are provided by [bash-preexec](https://github.com/rcaloras/bash-preexec).

They aim to emulate the behavior as described for Zsh.

### Usage Examples

#### When defined as a singular function

- `chpwd` Executed just before each prompt when the directory changes.
- `preexec` Executed just after a command has been read and is about to be executed. The string that the user typed is passed as the first argument.
- `precmd` Executed just before each prompt. Equivalent to PROMPT_COMMAND, but more flexible and resilient.

```bash
# using defined functions
chpwd() { echo "now in $(pwd)"; }
preexec() { echo "just typed $1"; }
precmd() { echo "printing the prompt"; }
```

#### Function Arrays

Multiple functions can also be defined to be invoked by appending them to the hook array variables. This is useful if there are multiple functions to be invoked for either hook.

- `$chpwd_functions` Array of functions invoked by chpwd.
- `$preexec_functions` Array of functions invoked by preexec.
- `$precmd_functions` Array of functions invoked by precmd.

```bash
precmd_hello_one() { echo "This is invoked on precmd first"; }
precmd_hello_two() { echo "This is invoked on precmd second"; }
precmd_functions+=(precmd_hello_one)
precmd_functions+=(precmd_hello_two)

chpwd_ls() { ls -1; }
chpwd_functions+=(chpwd_ls_one)
```

## Troubleshooting

### Slow shell startup

If shell startup takes more than a second, common culprits include:

- **nvm**: The nvm plugin lazy-loads `nvm.sh` on first use. The default node version's bin dir is cached in `~/.config/dotfiles/cache/nvm_default_path` so `node`/`npm`/`npx` are available immediately. If the cache is missing (first run), nvm is sourced eagerly once to seed it. Delete the cache file to force a refresh.
- **completions**: Completion scripts for tools like `kubectl`, `helm`, `gh` can add up. Completions are cached where possible; see `plugins/` for details.
- **prompt segments**: The load average and exec timer segments spawn subprocesses. Disable with `PS1_OPT_HIDE_LOAD=1` or `PS1_OPT_HIDE_EXEC_TIME=1` in `~/.bash_local`.
- **git prompt status**: If `__git_ps1` is still slow in very large repos, increase `DOT_GIT_PROMPT_CACHE_TTL_MS` or `DOT_GIT_PROMPT_CACHE_MAX_AGE_MS` in `~/.bash_local`.

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

The prompt uses UTF-8 symbols (lambda, mu, pi). Your terminal and font must support Unicode. Recommended fonts: Nerd Font variants (e.g., `JetBrainsMono Nerd Font`, `FiraCode Nerd Font`).

### `date2unix` doesn't work

On macOS, the function tries `gdate` (from `brew install coreutils`) automatically for GNU-style free-form dates, then falls back to BSD `date` with common format strings.

### Local overrides

Machine-specific configuration should go in `~/.bash_local`, which is sourced automatically if it exists. This keeps the dotfiles repo portable.

## Additional tools

### clipboard-server

[`clipboard-server`](./dotenv/bin/clipboard-server) is a server that sets up forward clipboard access over a http socket. This is useful if you want to copy/paste from over a ssh session.

To set up on the local machine

```bash
clipboard-server start
# this will create a socket file at $HOME/.config/clipboard-server/clipboard-server.sock
```

With the server running, you can now SSH into the remote machine, forwarding the socket

```bash
ssh -R 127.0.0.1:29009:$HOME/.config/clipboard-server/clipboard-server.sock user@HOST
```

Or through the `~/.ssh/config` file

```text
Host HOSTNAME
    RemoteForward 29009 /home/USERNAME/.config/clipboard-server/clipboard-server.sock
```

The on the remote machine, the port needs to be specified with the `CLIPBOARD_SERVER_PORT` env variable.

```bash
export CLIPBOARD_SERVER_PORT=29009

# then use the clipboard
date | pbcopy
pbpaste | sed ...
```
