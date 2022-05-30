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
- [Additional tools](#additional-tools)
  - [clipboard-server](#clipboard-server)

## Changes

- `sudo` works on aliases
- `rm` `cp` `mv` are always inteactive `-i` (use `-f` to override)
- `ls` and `grep` always has color (use `--color=never` to override)
- `which` command expands full path when possible
- `less` does not clear the screen upon exit and process colors (with options `-XR`)
- `diff` uses git's diff command with color when possible
- `pbcopy` and `pbpaste` for cross-platform copy/paste from cli, and optionally over ssh
- `open` for cross-platform open in native application

## New Global Variables

| ENV var          | Description                                                     |
| ---------------- | --------------------------------------------------------------- |
| `DOTENV`         | Simple access to os platform                                    |
| `DOTFILES__ROOT` | Root where dotfiles directory is installed (ex. `/home/ubuntu`) |
| `PROC_CORES`     | Number of threads (cores)                                       |

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

### Utilities

| Command                                 | Description                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `__push_internal_prompt_command`        | Pushes a new command to the internal stack to execute during `PROMPT_COMMAND`                        |
| `__push_prompt_command`                 | Pushes a new command to the `PROMPT_COMMAND` variable                                                |
| [`clipboard-server`](#clipboard-server) | Forward local clipboard access over a socket                                                         |
| `dataurl`                               | Create a data URL from an image                                                                      |
| `date2unix`                             | Convert a date string to a unix timestamp (`date2unix Fri, Feb 13, 2009 6:31:30 PM` => `1234567890`) |
| `extract`                               | Extracts a archive with autodetect based on extension                                                |
| `fromtime`                              | `unix2date`                                                                                          |
| `genpasswd`                             | Generate a random string of a certain length                                                         |
| `gz`                                    | Get the gzipped file size                                                                            |
| `parallel-xargs`                        | Run a command through xargs with that is sh wrapped (`parallel-xargs cat {}`)                        |
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
| `git hub-pull-request` | Open a pull request on github                                      |
| `git hub-token`        | Generate a github api access token                                 |
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
