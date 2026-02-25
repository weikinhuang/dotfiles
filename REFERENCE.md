# weikinhuang's dotfiles reference <!-- omit in toc -->

- [Changes](#changes)
- [New Global Variables](#new-global-variables)
- [All Platforms](#all-platforms)
  - [Navigation](#navigation)
  - [Directory Commands](#directory-commands)
  - [Shortcuts](#shortcuts)
- [Networking](#networking)
  - [String Manipulation](#string-manipulation)
  - [Utilities](#utilities)
  - [Git Utilities](#git-utilities)
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
- `rm` `cp` `mv` are always inteactive `-i` (use `-f` to override)
- `ls` and `grep` always has color (use `--color=never` to override)
- `which` command expands full path when possible
- `less` does not clear the screen upon exit and process colors (with options `-XR`)
- `gdiff` uses git's diff command with color when possible
- `pbcopy` and `pbpaste` for cross-platform copy/paste from cli, and optionally over ssh
- `open` for cross-platform open in native application

## New Global Variables

| ENV var           | Description                                                     |
| ----------------- | --------------------------------------------------------------- |
| `DOT___IS_SCREEN` | Set when the current environment is a screen session            |
| `DOT___IS_SSH`    | Set when the current environment is a ssh session               |
| `DOT___IS_WSL`    | Set when the current environment is running inside WSL          |
| `DOT___IS_WSL2`   | Set when the current environment is running inside WSL 2        |
| `DOTENV`          | Simple access to os platform                                    |
| `DOTFILES__ROOT`  | Root where dotfiles directory is installed (ex. `/home/ubuntu`) |
| `PROC_CORES`      | Number of threads (cores)                                       |

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

| Command    | Description                                                        |
| ---------- | ------------------------------------------------------------------ |
| `cf`       | Count the number of files in a directory                           |
| `dusort`   | Bar chart of all files and relative size                           |
| `findhere` | Case insensitive find in current directory (`find -iname "_arg_"`) |
| `grip`     | Case-insensetive grep on all the files in current directory        |
| `l.`       | Show files starting with `.`                                       |
| `la`       | Show all files in list format                                      |
| `lf`       | Show directories in list format                                    |
| `ll`       | Show files in list format                                          |
| `md`       | Create a new directory and enter it                                |

### Shortcuts

| Command | Description                              |
| ------- | ---------------------------------------- |
| `-`     | `cd -`                                   |
| `f`     | `findhere`                               |
| `h`     | `history`                                |
| `o`     | `open` (show in GUI file explorer)       |
| `oo`    | `open .` (show cwd in GUI file explorer) |
| `x`     | `parallel-xargs`                         |

## Networking

| Command   | Description                         |
| --------- | ----------------------------------- |
| `curl-gz` | Make gzip enabled curl requests     |
| `extip`   | Get the current external ip address |
| `ips`     | Get all bound internal ips          |

### String Manipulation

| Command     | Description                                                                       |
| ----------- | --------------------------------------------------------------------------------- |
| `codepoint` | Get a character's Unicode code point                                              |
| `escape`    | Escape UTF-8 characters into their 3-byte format (escape `λ` => `\xCE\xBB`)       |
| `lc`        | Convert to lowercase                                                              |
| `regex`     | Regex match and replace from [opsb/4409156](https://gist.github.com/opsb/4409156) |
| `uc`        | Convert to uppercase                                                              |
| `unidecode` | Decode `\x{ABCD}`-style Unicode escape sequences                                  |
| `binarydiff`| Binary diff two files using `vimdiff` and `xxd`                                   |

### Utilities

| Command                                 | Description                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `__push_internal_prompt_command`        | Pushes a new command to the internal stack to execute during `PROMPT_COMMAND`                        |
| `__push_path`                           | Pushes a new path to the `PATH` variable if directory exists (use `--prepend` to add to the front).  |
| `__push_prompt_command`                 | Pushes a new command to the `PROMPT_COMMAND` variable                                                |
| [`clipboard-server`](#clipboard-server) | Forward local clipboard access over a socket                                                         |
| `dataurl`                               | Create a data URL from an image                                                                      |
| `date2unix`                             | Convert a date string to a unix timestamp (`date2unix Fri, Feb 13, 2009 6:31:30 PM` => `1234567890`) |
| `extract`                               | Extracts an archive with autodetect based on extension                                               |
| `fromtime`                              | `unix2date`                                                                                          |
| `gdiff`                                 | Git-powered colored diff for comparing any two files (`gdiff file1 file2`)                           |
| `genpasswd`                             | Generate a random string of a certain length                                                         |
| `gz-size`                               | Get original and gzipped file size in bytes                                                          |
| `gz`                                    | Get the gzipped file size                                                                            |
| `parallel-xargs`                        | Run a command through xargs with that is sh wrapped (`parallel-xargs cat {}`)                        |
| `quick-toast`                           | Show a simple notification using OS primitives `quick-toast TITLE [BODY]`                            |
| `reload`                                | Reload the current environment                                                                       |
| `totime`                                | `date2unix`                                                                                          |
| `unix2date`                             | Convert a unix timestamp to a date string (`unix2date 1234567890` => `Fri, Feb 13, 2009 6:31:30 PM`) |

### Git Utilities

| Command                | Description                                                        |
| ---------------------- | ------------------------------------------------------------------ |
| `git auto-difftool`    | Use araxis merge when possible otherwise use `vimdiff`             |
| `git auto-mergetool`   | Use araxis merge when possible otherwise use `vimdiff`             |
| `git branch-prune`     | Remove branches locally and remotely if already merged into master |
| `git changelog`        | Generate a changelog from git tags                                 |
| `git cherry-pick-from` | Cherry pick commits from a different git repo                      |
| `git gh-pages`         | Setup a new branch called gh-pages following github procedure      |
| `git hooks`            | Execute a git hook                                                 |
| `git pr`               | Create a pull request on GitHub (opens web UI via `gh`)            |
| `git pr-get`           | Checkout a pull request locally via `gh`                           |
| `git ignore`           | Add a file/path to .gitignore                                      |
| `git ls-dir`           | List files in a git repo tree together with the latest commit      |
| `git remove-history`   | Permanently delete files/folders from repository                   |
| `git repl`             | Start a repl where all commands are prefixed with `git`            |
| `git sync`             | Sync origin with upstream remote                                   |
| `git touch`            | Make a new file and add it                                         |
| `git track`            | Sets up auto-tracking of a remote branch with same base name       |

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

- **nvm**: The nvm plugin sources nvm on every shell. If startup is slow, check if lazy loading is enabled in `plugins/20-nvm.sh`.
- **completions**: Completion scripts for tools like `kubectl`, `helm`, `gh` can add up. Completions are cached where possible; see `plugins/` for details.
- **prompt segments**: The load average and exec timer segments spawn subprocesses. Disable with `PS1_OPT_HIDE_LOAD=1` or `PS1_OPT_HIDE_EXEC_TIME=1` before sourcing.

To profile startup time:

```bash
time bash -i -c exit
```

### Prompt symbols display as boxes or question marks

The prompt uses UTF-8 symbols (lambda, mu, pi). Your terminal and font must support Unicode. Recommended fonts: Nerd Font variants (e.g., `JetBrainsMono Nerd Font`, `FiraCode Nerd Font`).

### `date2unix` doesn't work

On macOS, the function supports common date formats. For GNU-style free-form dates, install `coreutils` via Homebrew (`brew install coreutils`) and use `gdate` instead.

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
