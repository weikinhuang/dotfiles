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
[06:00:00 0.00 user#host dir<4|2.4Mb> 6.3ms]λ ──── The λ symbol denotes a regular user session
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
[06:00:00 0.00 root#host dir<4|2.4Mb>]μ
                                      └── The λ symbol is replaced with μ
```

When sudo'd

```text
when sudo ──────────────┐
[06:00:00 root#host dir]π
                        └── The λ symbol is replaced with π
```

WSL with elevated permissions

```text
elevated rights ──────────────────────┐
[06:00:00 0.00 user#host dir<4|2.4Mb>]W*
                                      └── Elevated Windows-backed WSL sessions use W*
```

## SSH prompt

```text
[06:00:00 0.00 user@host dir<4|2.4Mb>]λ
                   └─────── The # symbol is replaced with @
```

## Screen and Tmux

```text
in screen                               ┌── window id
[06:00:00 0.00 user#12345.pts-01.host01[1] dir<4|2.4Mb>]λ
                    └─────────────────┴──── Screen session name
```

```text
in tmux                             ┌── tmux pane
[06:00:00 0.00 user#host,tmux-86751[%0] dir<4|2.4Mb>]λ
                         └────────┴──── tmux session name
```

## `PS2` prompt

```text
[06:00:00 0.00 user#host dir<4|2.4Mb>]λ a '\
→ bcd'
```

## `PS4` debug prompt

When tracing with `set -x`, the prompt shows the source file, line number, and function name:

```text
+ script.sh:42 my_function(): some-command
```

## Git status

This segment appears only when `__git_ps1` is available. With the built-in setup that typically means `git` is installed
and `DOT_INCLUDE_BUILTIN_PLUGINS=1` enabled the git plugin. The segment contents come from the
[git/git](https://github.com/git/git/blob/master/contrib/completion/git-prompt.sh) repo.

```text
branch name──────────────────────────────┐      ┌───git status flags
[06:00:00 0.00 root#host dir<4|2.4Mb> (կ master %)]μ
```

When running under screen or tmux, the host portion is replaced with the session name and underlined.

Load is the 1-minute load average on Unix-like systems.

## Segment architecture

The prompt is built from an ordered list of segments. Each segment has a short name and a render function. At PS1 build
time, `internal::ps1-build` iterates `DOT_PS1_SEGMENTS` and calls each segment's render function.

### Default segment lists

```bash
# Main prompt
DOT_PS1_SEGMENTS=(exit_status bg_jobs time loadavg user session_host workdir dirinfo git exec_time)

# Sudo prompt (fewer segments)
DOT_SUDO_PS1_SEGMENTS=(exit_status bg_jobs time user session_host workdir)
```

### Built-in segments

| Segment        | Description                                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exit_status`  | non-zero exit code of the previous command                                                                                                                                                                    |
| `bg_jobs`      | number of running background jobs                                                                                                                                                                             |
| `time`         | current time with day/night color                                                                                                                                                                             |
| `loadavg`      | 1-minute load average with color gradient                                                                                                                                                                     |
| `user`         | current username                                                                                                                                                                                              |
| `session_host` | session type symbol and hostname (or tmux/screen session)                                                                                                                                                     |
| `workdir`      | current directory basename with non-writable marker; wrapped in an OSC 8 `file://` hyperlink when supported (suppressed over SSH without a VS Code-family terminal, and when `DOT_DISABLE_HYPERLINKS` is set) |
| `dirinfo`      | directory file count and total size                                                                                                                                                                           |
| `git`          | git branch, dirty state, stash, and upstream info                                                                                                                                                             |
| `exec_time`    | last command execution time                                                                                                                                                                                   |

### Custom segments

Define a `ps1_render_<name>` function in `~/.bash_local` and add the segment to the list:

```bash
# ~/.bash_local
ps1_render_venv() {
  [[ -z "${VIRTUAL_ENV:-}" ]] && return
  echo " (venv)"
}
internal::ps1-segment-add venv --after git
```

### Managing segments

```bash
# Remove a segment
internal::ps1-segment-remove loadavg

# Insert before another segment
internal::ps1-segment-add venv --before git

# Insert after another segment
internal::ps1-segment-add venv --after git

# Target the sudo prompt
internal::ps1-segment-add venv --sudo --after user

# Full control: set the list directly
DOT_PS1_SEGMENTS=(time user session_host workdir git)

# Rebuild prompts at runtime after changing segments
internal::ps1-segment-remove loadavg
internal::ps1-rebuild
```

## Configuration

The prompt can be configured in the `~/.bash_local` configuration file by setting the following environment variables.

### Disable the custom prompt

The custom prompt can be disabled with the following export.

```bash
export DOT_DISABLE_PS1=1
```

### Git Prompt Cache Controls

| Option                             | Default | Description                                                                           |
| ---------------------------------- | ------: | ------------------------------------------------------------------------------------- |
| `DOT_GIT_PROMPT_CACHE_TTL_MS`      |  `1000` | Milliseconds to reuse cached git prompt status before checking the current repo again |
| `DOT_GIT_PROMPT_CACHE_MAX_AGE_MS`  | `10000` | Maximum milliseconds to reuse unchanged git prompt status before forcing a refresh    |
| `DOT_GIT_PROMPT_INVALIDATE_ON_GIT` |     `1` | Set to `0` to disable automatic git prompt cache invalidation after git commands      |

### Prompt options

| Option                      |                         Default | Description                                                                                                    |
| --------------------------- | ------------------------------: | -------------------------------------------------------------------------------------------------------------- |
| `DOT_PS1_DAY_START`         |                             `8` | 24 hour format for when the daytime clock color starts                                                         |
| `DOT_PS1_DAY_END`           |                            `18` | 24 hour format for when the daytime clock color ends                                                           |
| `DOT_PS1_MONOCHROME`        |                         `UNSET` | When set, remove all colors                                                                                    |
| `DOT_PS1_MULTILINE`         |                         `UNSET` | When set, force prompt to be 2 lines                                                                           |
| `DOT_PS1_NEWLINE_THRESHOLD` |                           `120` | When the terminal is narrower than this many cols, force prompt to be 2 lines                                  |
| `DOT_PS1_TITLE`             |                         `UNSET` | Terminal title override; when unset, a terminal-specific default is used (`PROMPT_TITLE` accepted as fallback) |
| `DOT_PS2`                   |                            `→ ` | Continuation prompt (PS2)                                                                                      |
| `DOT_PS4`                   | `+ ${BASH_SOURCE}:${LINENO}...` | Debug/trace prompt (PS4)                                                                                       |

### Custom symbols for the PS1

| Option                        | Default | Description                                                               |
| ----------------------------- | :-----: | ------------------------------------------------------------------------- |
| `DOT_PS1_SYMBOL_NO_WRITE_PWD` |   `*`   | Symbol placed after the directory name when the directory is not writable |
| `DOT_PS1_SYMBOL_GIT`          |   `կ`   | Symbol placed before the git branch name                                  |
| `DOT_PS1_SYMBOL_SSH`          |   `@`   | Session symbol used between `user@hostname` over SSH                      |
| `DOT_PS1_SYMBOL_LOCAL`        |   `#`   | Session symbol used between `user#hostname` on local sessions             |
| `DOT_PS1_SYMBOL_USER`         |   `λ`   | Symbol for a regular user session                                         |
| `DOT_PS1_SYMBOL_ROOT`         |   `μ`   | Symbol for a root session                                                 |
| `DOT_PS1_SYMBOL_SU`           |   `π`   | Symbol used by `SUDO_PS1` in sudo shells entered from a non-root session  |
| `DOT_PS1_SYMBOL_WIN_PRIV`     |  `W*`   | Symbol for an elevated Windows-backed WSL session                         |

### Custom colors for the PS1

<!-- markdownlint-disable no-inline-html -->

Color values must be defined as ansi color escapes:

```bash
DOT_PS1_COLOR_WORK_DIRINFO='\[\e[38;5;35m\]'
```

| Option                       | Default                                                                                 | Description                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `DOT_PS1_COLOR_GREY`         | ![#808080](https://via.placeholder.com/15/808080/808080.png) `\e[38;5;244m`             | Default gray color for brackets                                                 |
| `DOT_PS1_COLOR_BG_JOBS`      | ![#00d787](https://via.placeholder.com/15/00d787/00d787.png) `\e[38;5;042m`             | Color used for background job info                                              |
| `DOT_PS1_COLOR_EXEC_TIME`    | ![#8a8a8a](https://via.placeholder.com/15/8a8a8a/8a8a8a.png) `\e[38;5;245m`             | Color used for the last command execution time                                  |
| `DOT_PS1_COLOR_EXIT_ERROR`   | ![#ff0000](https://via.placeholder.com/15/ff0000/ff0000.png) `\e[38;5;196m`             | Color used for a non-zero exit code                                             |
| `DOT_PS1_COLOR_GIT`          | ![#af5fff](https://via.placeholder.com/15/af5fff/af5fff.png) `\e[38;5;135m`             | Color used for the git segment                                                  |
| `DOT_PS1_COLOR_HOST_SCREEN`  | underline + ![#ffaf00](https://via.placeholder.com/15/ffaf00/ffaf00.png) `\e[38;5;214m` | Color used for screen or tmux session info in the host segment                  |
| `DOT_PS1_COLOR_HOST`         | ![#ff8700](https://via.placeholder.com/15/ff8700/ff8700.png) `\e[38;5;208m`             | Color used for the hostname portion of the prompt                               |
| `DOT_PS1_COLOR_TIME_DAY`     | ![#808080](https://via.placeholder.com/15/808080/808080.png) `\e[38;5;245m`             | Color used for the time during daytime                                          |
| `DOT_PS1_COLOR_TIME_NIGHT`   | ![#0087ff](https://via.placeholder.com/15/0087ff/0087ff.png) `\e[38;5;033m`             | Color used for the time during nighttime                                        |
| `DOT_PS1_COLOR_USER`         | ![#ff005f](https://via.placeholder.com/15/ff005f/ff005f.png) `\e[38;5;197m`             | Color used for the current username                                             |
| `DOT_PS1_COLOR_WORK_DIR`     | ![#afaf00](https://via.placeholder.com/15/afaf00/afaf00.png) `\e[38;5;142m`             | Color used for the current directory                                            |
| `DOT_PS1_COLOR_WORK_DIRINFO` | ![#00af5f](https://via.placeholder.com/15/00af5f/00af5f.png) `\e[38;5;035m`             | Color used for the directory file count and size                                |
| `DOT_PS1_COLOR_LOAD`         | See below                                                                               | Load-average color array defined as `DOT_PS1_COLOR_LOAD=( color1, color2, ...)` |

Load average colors: ![#87afff](https://via.placeholder.com/15/87afff/87afff.png) `0`
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

### SUDO_PS1 limitations

`SUDO_PS1` is fragile: sudo copies it into the child shell's `PS1`, but `/etc/bash.bashrc` or the target user's own
`.bashrc` often overwrites PS1 unconditionally. It only takes effect when sudo-ing to a user without their own prompt
setup.

### `internal::ps1-rebuild` and cleanup

After the initial prompt build, `DOT_PS1_COLOR_*` and `DOT_PS1_SYMBOL_*` variables are cleaned up so they don't leak
into the environment. If `internal::ps1-rebuild` is called later, render functions fall back to their hardcoded
defaults. User config variables are only read once at initial build time.

## The MySQL client Prompt

```text
user@host [database]→
```

## The Mongo client Prompt

```text
host [database]>
PRIMARY:[replset]#host [database]>
```
