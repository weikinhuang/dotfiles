# The Bash Prompt

```bash
[exitstatus jobs time load user#host workdir<dirinfo> (git info) lastcmdtime]user symbol
```

Example:

![Prompt example](./assets/prompt-example.svg)

## The basic prompt

```text
    ┌─ Time              ┌─ The current working directory
    │     ┌─ System load │   ┌─ Number of files in directory
    │     │              │   │ ┌─ Size of files (non-recursive) in directory
    │     │              │   │ │
[06:00:00 0.00 user#host dir<4|2.4Mb> 6.3ms]λ ──── The λ symbol denotes non sudo'ed user/session
                │  │ │                └─ Process timings
                │  │ └─ The hostname of the session
                │  └─ The # symbol denotes local session
                └─ Logged in user

    ┌── Exit status of previous command, shows only when $? != 0
[(E:1) 06:00:00 0.00 user#host dir<4|2.4Mb> 6.3ms]λ

          ┌── Number of running background jobs
[(E:1) bg:2 06:00:00 0.00 user#host dir<4|2.4Mb> 6.3ms]λ
```

## root and sudo prompt

```text
as root ──────────────────────────────┐
[06:00:00 0.00 root@host dir<4|2.4Mb>]μ
                                      └── The λ symbol is replace with μ
```

When sudo'd

```text
when sudo ──────────────┐
[06:00:00 user@host dir]π
                        └── The λ symbol is replace with π
```

WSL with elevated permissions

```text
elevated rights ──────────────────────┐
[06:00:00 0.00 root@host dir<4|2.4Mb>]W*
                                      └── The λ symbol is replace with W*
```

## SSH prompt

```text
[06:00:00 0.00 user@host dir<4|2.4Mb>]λ
                   └─────── The # symbol is replace with @
```

## Screen and Tmux

```text
in screen                               ┌── window id
[06:00:00 0.00 user@12345.pts-01.host01[1] dir<4|2.4Mb>]λ
                    └─────────────────┴──── Screen session name
```

```text
in tmux                             ┌── tmux pane
[06:00:00 0.00 user@host,tmux-86751[%0] dir<4|2.4Mb>]λ
                         └────────┴──── tmux session name
```

## `PS2` prompt

```text
[06:00:00 0.00 user#host dir<4|2.4Mb>]λ a '\
→ bcd'
```

## Git status

The contents of this portion of the prompt is in the [git/git](https://github.com/git/git/blob/master/contrib/completion/git-prompt.sh) repo.

```text
branch name──────────────────────────────┐      ┌───git status flags
[06:00:00 0.00 root@host dir<4|2.4Mb> (կ master %)]μ
```

When on screen host is replaced with session name and is underlined.

load = 1 min load avg on \*nix/osx/wsl

## Configuration

The prompt can be configured in the `~/.bash_local` configuration file by setting the following environment variables.

### Disable the custom prompt

The custom prompt can be disabled with the following export.

```bash
export DOT_DISABLE_PS1=1
```

### Custom options for the PS1

| Option                      |         Default | Description                                                                                                         |
| --------------------------- | --------------: | ------------------------------------------------------------------------------------------------------------------- |
| `PS1_OPT_DAY_START`         |             `8` | 24 hour format for start of the daytime color                                                                       |
| `PS1_OPT_DAY_END`           |            `18` | 24 hour format for start of the nighttime color                                                                     |
| `PS1_OPT_HIDE_DIR_INFO`     |         `UNSET` | When set, hide segment showing directory file count and size                                                        |
| `PS1_OPT_HIDE_EXEC_TIME`    |         `UNSET` | When set, hide segment showing last command execution time                                                          |
| `PS1_OPT_HIDE_GIT`          |         `UNSET` | When set, hide segment showing git info                                                                             |
| `PS1_OPT_HIDE_LOAD`         |         `UNSET` | When set, hide segment showing the 1m load                                                                          |
| `PS1_OPT_HIDE_TIME`         |         `UNSET` | When set, hide segment showing the current time                                                                     |
| `PS1_OPT_MONOCHROME`        |         `UNSET` | When set, remove all colors                                                                                         |
| `PS1_OPT_MULTILINE`         |         `UNSET` | When set, force prompt to be 2 lines                                                                                |
| `PS1_OPT_NEWLINE_THRESHOLD` |           `120` | When the terminal exceeds this many cols, force prompt to be 2 lines                                                |
| `PS1_OPT_SEGMENT_EXTRA`     |         `UNSET` | Additional segments to be placed after the `git` segment, but before the cmd execution time, in `PS1` string format |
| `PROMPT_TITLE`              | `user@host:dir` | Terminal title                                                                                                      |

### Custom symbols for the PS1

| Option                    | Default | Description                                                         |
| ------------------------- | :------ | ------------------------------------------------------------------- |
| `PS1_SYMBOL_NO_WRITE_PWD` | `*`     | Symbol placed after directory name when directory is not writable   |
| `PS1_SYMBOL_GIT`          | `կ`     | Symbol placed before git branch name                                |
| `PS1_SYMBOL_SSH`          | `@`     | Session symbol used between `user@hostname` when connected over ssh |
| `PS1_SYMBOL_LOCAL`        | `#`     | Session symbol used between `user@hostname` on local sessions       |
| `PS1_SYMBOL_USER`         | `λ`     | Symbol to denote a regular user session                             |
| `PS1_SYMBOL_ROOT`         | `μ`     | Symbol to denote a root user session                                |
| `PS1_SYMBOL_SU`           | `π`     | Symbol to denote a regular user session                             |
| `PS1_SYMBOL_WIN_PRIV`     | `W*`    | Symbol to denote an elevated Windows session (Administrator)        |

### Custom colors for the PS1

<!-- markdownlint-disable no-inline-html -->

Color values must be defined as ansi color escapes:

```bash
PS1_COLOR_WORK_DIRINFO='\[\e[38;5;35m\]'
```

| Option                   |                                                                                 Default | Description                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------: | ---------------------------------------------------------------------------------------------------------------------- |
| `PS1_COLOR_GREY`         |             ![#808080](https://via.placeholder.com/15/808080/808080.png) `\e[38;5;244m` | Default gray color for brackets                                                                                        |
| `PS1_COLOR_BG_JOBS`      |              ![#00d787](https://via.placeholder.com/15/00d787/00d787.png) `\e[38;5;042m` | Color used for background job info                                                                                     |
| `PS1_COLOR_EXEC_TIME`    |             ![#8a8a8a](https://via.placeholder.com/15/8a8a8a/8a8a8a.png) `\e[38;5;245m` | Color used for the last command execution time                                                                         |
| `PS1_COLOR_EXIT_ERROR`   |             ![#ff0000](https://via.placeholder.com/15/ff0000/ff0000.png) `\e[38;5;196m` | Color used for the last command exit code when not `0`                                                                 |
| `PS1_COLOR_GIT`          |             ![#af5fff](https://via.placeholder.com/15/af5fff/af5fff.png) `\e[38;5;135m` | Color used for the `git` info                                                                                          |
| `PS1_COLOR_HOST_SCREEN`  | underline + ![#ffaf00](https://via.placeholder.com/15/ffaf00/ffaf00.png) `\e[38;5;214m` | Color used for the screen session info (after the `user@`)                                                             |
| `PS1_COLOR_HOST`         |             ![#ff8700](https://via.placeholder.com/15/ff8700/ff8700.png) `\e[38;5;208m` | Color used for the hostname (after the `user@`)                                                                        |
| `PS1_COLOR_TIME_DAY`     |             ![#808080](https://via.placeholder.com/15/808080/808080.png) `\e[38;5;245m` | Color used for the time during daytime                                                                                 |
| `PS1_COLOR_TIME_NIGHT`   |             ![#0087ff](https://via.placeholder.com/15/0087ff/0087ff.png) `\e[38;5;033m` | Color used for the time during nighttime                                                                               |
| `PS1_COLOR_USER`         |             ![#ff005f](https://via.placeholder.com/15/ff005f/ff005f.png) `\e[38;5;197m` | Color used for the current username                                                                                    |
| `PS1_COLOR_WORK_DIR`     |             ![#afaf00](https://via.placeholder.com/15/afaf00/afaf00.png) `\e[38;5;142m` | Color used for the current directory                                                                                   |
| `PS1_COLOR_WORK_DIRINFO` |              ![#00af5f](https://via.placeholder.com/15/00af5f/00af5f.png) `\e[38;5;035m` | Color used for showing the current directory file count and size                                                       |
| `PS1_COLOR_LOAD`         |                                                                               See below | Color array for load averages. This is defined as an array value `PS1_COLOR_LOAD=( color1, color2, ...)` and 0 indexed |

Load average colors:
![#87afff](https://via.placeholder.com/15/87afff/87afff.png) `0`
![#87afd7](https://via.placeholder.com/15/87afd7/87afd7.png) `1`
![#87afaf](https://via.placeholder.com/15/87afaf/87afaf.png) `2`
![#87af87](https://via.placeholder.com/15/87af87/87af87.png) `3`
![#87af5f](https://via.placeholder.com/15/87af5f/87af5f.png) `4`
![#87af00](https://via.placeholder.com/15/87af00/87af00.png) `5`
![#d7af00](https://via.placeholder.com/15/d7af00/d7af00.png) `6`
![#d78700](https://via.placeholder.com/15/d78700/d78700.png) `7`
![#d75f00](https://via.placeholder.com/15/d75f00/d75f00.png) `8`
![#d75f5f](https://via.placeholder.com/15/d75f5f/d75f5f.png) `9+`

<!-- markdownlint-enable no-inline-html -->

See [ditig.com/256-colors-cheat-sheet](https://www.ditig.com/256-colors-cheat-sheet) for reference to xterm 256 colors.

## The MySQL client Prompt

```text
user@host [database]→
```

## The Mongo client Prompt

```text
host[database]>
state[repl]#host [database]>
```
