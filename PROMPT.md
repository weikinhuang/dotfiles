# The Bash Prompt

```bash
[exitstatus jobs time load user#host workdir<dirinfo> (git info)]user symbol
```

![Prompt example](./assets/prompt-example.png)

The prompt

```text
    ┌─ Time              ┌─ The current working directory
    │     ┌─ System load │   ┌─ Number of files in directory
    │     │              │   │ ┌─ Size of files (non-recursive) in directory
    │     │              │   │ │
[06:00:00 0.00 user#host dir<4|2.4Mb>]λ ──── The λ symbol denotes non sudo'ed user/session
                │  │ │
                │  │ └─ The hostname of the session
                │  └─ The # symbol denotes local session
                └─ Logged in user

    ┌── Exit status of previous command
[(E:1) 06:00:00 0.00 user#host dir<4|2.4Mb>]λ

          ┌── Number of running background jobs
[(E:1) bg:2 06:00:00 0.00 user#host dir<4|2.4Mb>]λ

```

When on ssh

```text
on ssh ────────────┐
[06:00:00 0.00 user@host dir<4|2.4Mb>]λ
                   └─────── The # symbol is replace with @
```

When logged in as root user

```text
as root ──────────────────────────────┐
[06:00:00 0.00 root@host dir<4|2.4Mb>]μ
                                      └── The λ symbol is replace with μ
```

When sudo'd

```text
as sudo ────────────────┐
[06:00:00 user@host dir]π
                        └── The λ symbol is replace with π
```

When on screen

```text
in screen                               ┌── window id
[06:00:00 0.00 user@12345.pts-01.host01[1] dir<4|2.4Mb>]λ
                    └─────────────────┴──── Screen session name
```

PS2 prompt

```text
[06:00:00 0.00 user#host dir<4|2.4Mb>]λ a '\
→ bcd'
```

Git prompt

```text
branch name──────────────────────────────┐      ┌───git status flags
[06:00:00 0.00 root@host dir<4|2.4Mb> (կ master %)]μ
```

When on screen host is replaced with session name and is underlined.

load = 1 min load avg on \*nix/osx/wsl

## Custom options for the PS1

Place these options in `~/.prompt_exports`

Turn off the load indicator

```bash
export _PS1_HIDE_LOAD=1
```

Turn off the directory info

```bash
export _PS1_HIDE_DIR_INFO=1
```

Turn off the time

```bash
export _PS1_HIDE_TIME=1
```

Monochrome prompt

```bash
export _PS1_MONOCHROME=1
```

Multiline prompt

```bash
export _PS1_MULTILINE=1
```

Custom colors for prompt

```bash
# general colors
PS1_COLOR_NORMAL='\[\e[m\]'
PS1_COLOR_BOLD='\[\e[1m\]'
PS1_COLOR_UNDERLINE='\[\e[4m\]'
PS1_COLOR_RESET='\[\e[0m\]'
PS1_COLOR_GREY='\[\e[38;5;244m\]'

# colors for individual parts of the bash prompt
PS1_COLOR_EXIT_ERROR='\[\e[38;5;196m\]'
PS1_COLOR_BG_JOBS='\[\e[38;5;42m\]'
PS1_COLOR_USER='\[\e[38;5;197m\]'
PS1_COLOR_HOST='\[\e[38;5;208m\]'
PS1_COLOR_HOST_SCREEN=$PS1_COLOR_UNDERLINE'\[\e[38;5;214m\]'
PS1_COLOR_WORK_DIR='\[\e[38;5;142m\]'
PS1_COLOR_WORK_DIRINFO='\[\e[38;5;35m\]'
PS1_COLOR_GIT='\[\e[38;5;135m\]'
PS1_COLOR_TIME_AM='\[\e[38;5;244m\]'
PS1_COLOR_TIME_PM='\[\e[38;5;033m\]'

# load avg colorization
PS1_COLOR_LOAD='
    loadcolors_0="\[\e[38;5;111m\]"
    loadcolors_1="\[\e[38;5;110m\]"
    loadcolors_2="\[\e[38;5;109m\]"
    loadcolors_3="\[\e[38;5;108m\]"
    loadcolors_4="\[\e[38;5;107m\]"
    loadcolors_5="\[\e[38;5;106m\]"
    loadcolors_6="\[\e[38;5;178m\]"
    loadcolors_7="\[\e[38;5;172m\]"
    loadcolors_8="\[\e[38;5;166m\]"
    loadcolors_9="\[\e[38;5;167m\]"
'
```

Custom symbols and variables for the bash prompt

```bash
# the symbol to be displayed when current the directory is readonly: "*"
PS1_SYMBOL_NO_WRITE_PWD='*'
# symbol to display when in a git branch: "կ "
PS1_SYMBOL_GIT_BRANCH="${PS1_COLOR_BOLD}$(echo -e '\xD5\xAF')${PS1_COLOR_NORMAL} "

# symbol to display when in ssh shell: "@"
PS1_SYMBOL_SSH='@'
# symbol to use when in a local shell: "#"
PS1_SYMBOL_LOCAL='#'

# symbol to use when user is a normal user: λ""
PS1_SYMBOL_USER="$(echo -e "\xCE\xBB")"
# symbol to use when user root: "μ"
PS1_SYMBOL_ROOT="$(echo -e "\xCE\xBC")"
# symbol to use when sudo'd as a normal user: "π"
PS1_SYMBOL_SU="$(echo -e "\xCF\x80\x0A")"

# hour to start the day color for time: 8:00am
PS1_DAY_START=8
# hour to start the night color for time: 6:00pm
PS1_DAY_END=18
```

## The MySQL client Prompt

```text
user@host [database]→
```

## The Mongo client Prompt

```text
host[database]>
state[repl]#host [database]>
```