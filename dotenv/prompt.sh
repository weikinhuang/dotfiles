# shellcheck shell=bash

# ------------------------------------------------------------------------------
# DISABLE PROMPT
# ------------------------------------------------------------------------------
if [[ -n "${DOT_DISABLE_PS1:-}" ]]; then
  unset DOT_DISABLE_PS1
  return
fi

# ------------------------------------------------------------------------------
# COLOR REFERENCES AND OPTIONS
# ------------------------------------------------------------------------------
# quick reference to colors
PS1_COLOR_NORMAL='\[\e[m\]'
PS1_COLOR_BOLD='\[\e[1m\]'
PS1_COLOR_UNDERLINE='\[\e[4m\]'
PS1_COLOR_RESET='\[\e[0m\]'
[[ -z "${PS1_COLOR_GREY+x}" ]] && PS1_COLOR_GREY='\[\e[38;5;244m\]'

# colors for individual parts of the bash prompt
[[ -z "${PS1_COLOR_EXIT_ERROR+x}" ]] && PS1_COLOR_EXIT_ERROR='\[\e[38;5;196m\]'
[[ -z "${PS1_COLOR_BG_JOBS+x}" ]] && PS1_COLOR_BG_JOBS='\[\e[38;5;42m\]'
[[ -z "${PS1_COLOR_USER+x}" ]] && PS1_COLOR_USER='\[\e[38;5;197m\]'
[[ -z "${PS1_COLOR_HOST+x}" ]] && PS1_COLOR_HOST='\[\e[38;5;208m\]'
[[ -z "${PS1_COLOR_HOST_SCREEN+x}" ]] && PS1_COLOR_HOST_SCREEN=${PS1_COLOR_UNDERLINE}'\[\e[38;5;214m\]'
[[ -z "${PS1_COLOR_WORK_DIR+x}" ]] && PS1_COLOR_WORK_DIR='\[\e[38;5;142m\]'
[[ -z "${PS1_COLOR_WORK_DIRINFO+x}" ]] && PS1_COLOR_WORK_DIRINFO='\[\e[38;5;35m\]'
[[ -z "${PS1_COLOR_GIT+x}" ]] && PS1_COLOR_GIT='\[\e[38;5;135m\]'
[[ -z "${PS1_COLOR_EXEC_TIME+x}" ]] && PS1_COLOR_EXEC_TIME='\[\e[38;5;245m\]'
[[ -z "${PS1_COLOR_TIME_DAY+x}" ]] && PS1_COLOR_TIME_DAY='\[\e[38;5;244m\]'
[[ -z "${PS1_COLOR_TIME_NIGHT+x}" ]] && PS1_COLOR_TIME_NIGHT='\[\e[38;5;033m\]'

# load avg colorization
declare -p PS1_COLOR_LOAD &>/dev/null || PS1_COLOR_LOAD=(
  '\[\e[38;5;111m\]'
  '\[\e[38;5;110m\]'
  '\[\e[38;5;109m\]'
  '\[\e[38;5;108m\]'
  '\[\e[38;5;107m\]'
  '\[\e[38;5;106m\]'
  '\[\e[38;5;178m\]'
  '\[\e[38;5;172m\]'
  '\[\e[38;5;166m\]'
  '\[\e[38;5;167m\]'
)

# If we want a monochrome bash prompt
if [[ -n "${PS1_OPT_MONOCHROME:-}" ]]; then
  # quick reference to colors
  PS1_COLOR_GREY=

  # colors for individual parts of the bash prompt
  PS1_COLOR_EXIT_ERROR=
  PS1_COLOR_BG_JOBS=
  PS1_COLOR_USER=
  PS1_COLOR_HOST=
  PS1_COLOR_HOST_SCREEN="${PS1_COLOR_UNDERLINE}"
  PS1_COLOR_WORK_DIR=
  PS1_COLOR_WORK_DIRINFO=
  PS1_COLOR_GIT=
  PS1_COLOR_TIME_DAY=
  PS1_COLOR_TIME_NIGHT=

  # load avg colorization
  PS1_COLOR_LOAD=()
fi

# ------------------------------------------------------------------------------
# SYMBOLS AND VARIABLES FOR PROMPTS
# ------------------------------------------------------------------------------
[[ -z "${PS1_SYMBOL_NO_WRITE_PWD+x}" ]] && PS1_SYMBOL_NO_WRITE_PWD='*'
[[ -z "${PS1_SYMBOL_GIT+x}" ]] && PS1_SYMBOL_GIT="${PS1_COLOR_BOLD}$(echo -e '\xD5\xAF')${PS1_COLOR_NORMAL} "
[[ -z "${PS1_SYMBOL_SSH+x}" ]] && PS1_SYMBOL_SSH='@'
[[ -z "${PS1_SYMBOL_LOCAL+x}" ]] && PS1_SYMBOL_LOCAL='#'

[[ -z "${PS1_SYMBOL_USER+x}" ]] && PS1_SYMBOL_USER="$(echo -e "\xCE\xBB")" # λ
[[ -z "${PS1_SYMBOL_ROOT+x}" ]] && PS1_SYMBOL_ROOT="$(echo -e "\xCE\xBC")" # μ
[[ -z "${PS1_SYMBOL_SU+x}" ]] && PS1_SYMBOL_SU="$(echo -e "\xCF\x80\x0A")" # π
[[ -z "${PS1_SYMBOL_WIN_PRIV+x}" ]] && PS1_SYMBOL_WIN_PRIV="W*" # W*

[[ -z "${PS1_OPT_DAY_START+x}" ]] && PS1_OPT_DAY_START=8
[[ -z "${PS1_OPT_DAY_END+x}" ]] && PS1_OPT_DAY_END=18

[[ -z "${PS1_OPT_NEWLINE_THRESHOLD+x}" ]] && PS1_OPT_NEWLINE_THRESHOLD=120

# ------------------------------------------------------------------------------
# FUNCTIONS AND REUSED STATEMENTS FOR PROMPTS
# ------------------------------------------------------------------------------

# show the exit status of the previous command
# shellcheck disable=SC2016,SC2089
_PS1_SEGMENT_EXIT_STATUS='$(EXIT="$?"; [[ $EXIT -ne 0 ]] && echo -n "(E:${EXIT}) ")'

# show the number of running background jobs
# shellcheck disable=SC2016
_PS1_SEGMENT_BG_JOBS='$([[ \j -gt 0 ]] && echo -n "bg:\j ")'

# session type symbol [@|#]
_PS1_SEGMENT_SESSION_TYPE="${PS1_SYMBOL_LOCAL}"
if [[ -n "${DOT___IS_SSH}" ]]; then
  _PS1_SEGMENT_SESSION_TYPE="${PS1_SYMBOL_SSH}"
fi

# show icon if the directory is not writable for the user
# shellcheck disable=SC2016
_PS1_SEGMENT_PWD_WRITABLE='$([[ ! -w "$PWD" ]] && echo -n "'${PS1_SYMBOL_NO_WRITE_PWD}'")'

# hostname or session info
_PS1_SEGMENT_HOSTNAME="${PS1_COLOR_HOST}\h"
case "$TERM" in
  screen*)
    if [[ -n "${TMUX:-}" ]]; then
      _PS1_SEGMENT_HOSTNAME="${PS1_COLOR_HOST_SCREEN}$([[ -n "${DOT___IS_SSH:-}" ]] && echo '\h,')$(tmux display-message -p '#S')[${TMUX_PANE}]"
    else
      _PS1_SEGMENT_HOSTNAME="${PS1_COLOR_HOST_SCREEN}$([[ -n "${DOT___IS_SSH:-}" ]] && echo '\h,')${STY}[${WINDOW}]"
    fi
    ;;
esac

# PROMPT_TITLE -- Set the title bar if we are in xterm
if ! declare -p PROMPT_TITLE &>/dev/null; then
  PROMPT_TITLE=
  case "${TERM}" in
    xterm* | rxvt*)
      PROMPT_TITLE="\[\e]0;\u@\h:\W\007\]"
      ;;
    screen*)
      if [[ -n "${TMUX:-}" ]]; then
        PROMPT_TITLE="\[\e]0;\u@\h:\W\007\]"
      else
        PROMPT_TITLE="\[\e]0;\u@${STY}[${WINDOW}]:\W\007\]"
      fi
      ;;
  esac
fi

# show time with color highlight
# shellcheck disable=SC2016
_PS1_SEGMENT_DATETIME="$(tr -d '\n' <<<'
  time=$(/bin/date +"%H" | sed 's/^0//');
  color="'"${PS1_COLOR_TIME_NIGHT}"'";
  if [[ ${time} -ge '${PS1_OPT_DAY_START}' && ${time} -le '${PS1_OPT_DAY_END}' ]]; then
     color="'"${PS1_COLOR_TIME_DAY}"'";
  fi;
  echo "${color}\T'"${PS1_COLOR_RESET}"' "
')"

# show load average with highlight
# shellcheck disable=SC2016,SC2046
_PS1_SEGMENT_LOADAVG="$(tr -d '\n' <<<'
  load=$(__ps1_proc_use);
  loadcolors=('$(printf "'%s' " "${PS1_COLOR_LOAD[@]}")');
  __ps1_var_loadmod="$(echo "${load}" | cut -f1 -d.)";
  [[ -z "${__ps1_var_loadmod}" ]] && __ps1_var_loadmod=0;
  [[ "${__ps1_var_loadmod}" -gt '$((${#PS1_COLOR_LOAD[@]} - 1))' ]] && __ps1_var_loadmod='$((${#PS1_COLOR_LOAD[@]} - 1))';
  echo "${loadcolors[$__ps1_var_loadmod]}${load}'"${PS1_COLOR_RESET}"' ";
')"

# caching the directory information for bash prompt to reduce disk reads
if [[ -z "${PS1_OPT_HIDE_DIR_INFO:-}" ]]; then
  __ps1_var_dirinfo=
  function __ps1_dir_info_wrapper() {
    local lsout lsnum lssize

    lsout=$(\ls -lAh 2>/dev/null)
    lsnum=$(($(echo "${lsout}" | \wc -l) - 1))
    lssize="$(echo "${lsout}" | \grep '^total ' | \awk '{ print $2 }')b"

    __ps1_var_dirinfo="<${lsnum}|${lssize}>"
  }
  chpwd_functions+=(__ps1_dir_info_wrapper)
fi

# show information about the last process
if [[ -z "${PS1_OPT_HIDE_EXEC_TIME:-}" ]]; then
  __ps1_var_exectimer=0
  __ps1_var_execduration=
  function __ps1_exec_timer_start() {
    # set on first command in the stack only
    if [[ __ps1_var_exectimer -gt 0 ]]; then
      return
    fi
    __ps1_var_exectimer=$(date +%s%N)
  }
  preexec_functions+=(__ps1_exec_timer_start)

  function __ps1_exec_timer_stop() {
    # only show if there was a prior command
    if [[ __ps1_var_exectimer -eq 0 ]]; then
      __ps1_var_execduration=
      return
    fi
    local duration
    local delta_us=$((($(date +%s%N) - __ps1_var_exectimer) / 1000))
    local us=$((delta_us % 1000))
    local ms=$(((delta_us / 1000) % 1000))
    local s=$(((delta_us / 1000000) % 60))
    local m=$(((delta_us / 60000000) % 60))
    local h=$((delta_us / 3600000000))
    if ((h > 0)); then
      duration=${h}h${m}m
    elif ((m > 0)); then
      duration=${m}m${s}s
    elif ((s >= 10)); then
      duration=${s}.$((ms / 100))s
    elif ((s > 0)); then
      duration=${s}.$(printf %03d $ms)s
    elif ((ms >= 100)); then
      duration=${ms}ms
    elif ((ms > 0)); then
      duration=${ms}.$((us / 100))ms
    else
      duration=${us}us
    fi

    # reset timer
    __ps1_var_exectimer=0
    # add space
    __ps1_var_execduration=" ${duration}"
  }
  __push_internal_prompt_command __ps1_exec_timer_stop
fi

# ------------------------------------------------------------------------------
# PROMPT GENERATION
# ------------------------------------------------------------------------------
# generate the bash prompt
function __ps1_create() {
  local PS1=""

  # [ -- open bracket
  PS1="${PS1}${PS1_COLOR_BOLD}${PS1_COLOR_GREY}[${PS1_COLOR_RESET}"

  # (E:1) -- exit code
  PS1="${PS1}${PS1_COLOR_EXIT_ERROR}${_PS1_SEGMENT_EXIT_STATUS}${PS1_COLOR_RESET}"

  # bg:1 -- number of background jobs
  PS1="${PS1}${PS1_COLOR_BG_JOBS}${_PS1_SEGMENT_BG_JOBS}${PS1_COLOR_RESET}"

  # time
  if [[ -z "${PS1_OPT_HIDE_TIME:-}" ]]; then
    PS1="${PS1}\$(${_PS1_SEGMENT_DATETIME})"
  fi

  # load average
  if [[ -z "${PS1_OPT_HIDE_LOAD:-}" ]]; then
    PS1="${PS1}\$(${_PS1_SEGMENT_LOADAVG})"
  fi

  # current user
  PS1="${PS1}${PS1_COLOR_USER}\u${PS1_COLOR_RESET}"

  # @|# - session type
  PS1="${PS1}${PS1_COLOR_GREY}${_PS1_SEGMENT_SESSION_TYPE}${PS1_COLOR_RESET}"
  # hostname or session info
  PS1="${PS1}${_PS1_SEGMENT_HOSTNAME}${PS1_COLOR_RESET} "

  # working directory
  PS1="${PS1}${PS1_COLOR_WORK_DIR}${_PS1_SEGMENT_PWD_WRITABLE}\W${PS1_COLOR_RESET}"

  # working directory information (number of files | total file size)
  if [[ -z "${PS1_OPT_HIDE_DIR_INFO:-}" ]]; then
    PS1="${PS1}${PS1_COLOR_WORK_DIRINFO}\${__ps1_var_dirinfo}${PS1_COLOR_RESET}"
  fi

  # git status only if the git repo status function is installed
  if [[ -z "${PS1_OPT_HIDE_GIT:-}" ]] && command -v __git_ps1 &>/dev/null; then
    PS1="${PS1}${PS1_COLOR_GIT}\$(__git_ps1 \" (${PS1_SYMBOL_GIT}${PS1_COLOR_RESET}${PS1_COLOR_GIT}%s)\")${PS1_COLOR_RESET}"
  fi

  # any additional blocks from the local prompt config
  if [[ -n "${PS1_OPT_SEGMENT_EXTRA:-}" ]]; then
    PS1="${PS1}${PS1_OPT_SEGMENT_EXTRA}${PS1_COLOR_RESET}"
  fi

  # process information
  if [[ -z "${PS1_OPT_HIDE_EXEC_TIME:-}" ]]; then
    PS1="${PS1}${PS1_COLOR_EXEC_TIME}\${__ps1_var_execduration}${PS1_COLOR_RESET}"
  fi

  # ] -- close bracket
  PS1="${PS1}${PS1_COLOR_BOLD}${PS1_COLOR_GREY}]${PS1_COLOR_RESET}"

  # newline before the user symbol if necessary
  if [[ -n "${PS1_OPT_MULTILINE:-}" ]]; then
    PS1="${PS1}\n"
  elif command -v tput &>/dev/null && [[ $(tput cols) -lt ${PS1_OPT_NEWLINE_THRESHOLD} ]]; then
    PS1="${PS1}\n"
  fi

  # prompt status symbol
  PS1="${PS1}${PS1_COLOR_BOLD}"
  if [[ -n "${DOT___IS_WSL}" ]] && command -v powershell.exe &>/dev/null && is-elevated-session; then
    # W* -- windows elevated session
    PS1="${PS1}${PS1_SYMBOL_WIN_PRIV}"
  elif [[ "$(id -u)" == 0 ]]; then
    PS1="${PS1}${PS1_SYMBOL_ROOT}"
  else
    PS1="${PS1}${PS1_SYMBOL_USER}"
  fi
  PS1="${PS1}${PS1_COLOR_RESET}"

  # terminal title + spacer
  echo "${PROMPT_TITLE}${PS1} "
}

# generate the sudo bash prompt
function __sudo_ps1_create() {
  local PS1=""

  # [ -- open bracket
  PS1="${PS1}${PS1_COLOR_BOLD}${PS1_COLOR_GREY}[${PS1_COLOR_RESET}"
  # (E:1) -- exit code
  PS1="${PS1}${PS1_COLOR_EXIT_ERROR}${_PS1_SEGMENT_EXIT_STATUS}${PS1_COLOR_RESET}"
  # bg:1 -- number of background jobs
  PS1="${PS1}${PS1_COLOR_BG_JOBS}${_PS1_SEGMENT_BG_JOBS}${PS1_COLOR_RESET}"
  # time
  if [[ -z "${PS1_OPT_HIDE_TIME:-}" ]]; then
    PS1="${PS1}\$(${_PS1_SEGMENT_DATETIME})"
  fi
  # current user
  PS1="${PS1}${PS1_COLOR_USER}\u${PS1_COLOR_RESET}"
  # @|# - session type
  PS1="${PS1}${PS1_COLOR_GREY}${_PS1_SEGMENT_SESSION_TYPE}${PS1_COLOR_RESET}"
  # hostname or session info
  PS1="${PS1}${_PS1_SEGMENT_HOSTNAME}${PS1_COLOR_RESET} "
  # working directory
  PS1="${PS1}${PS1_COLOR_WORK_DIR}${_PS1_SEGMENT_PWD_WRITABLE}\W${PS1_COLOR_RESET}"
  # ] -- close bracket
  PS1="${PS1}${PS1_COLOR_BOLD}${PS1_COLOR_GREY}]${PS1_COLOR_RESET}"

  # newline before the user symbol if necessary
  if [[ -n "${PS1_OPT_MULTILINE:-}" ]]; then
    PS1="${PS1}\n"
  elif command -v tput &>/dev/null && [[ $(tput cols) -lt ${PS1_OPT_NEWLINE_THRESHOLD} ]]; then
    PS1="${PS1}\n"
  fi

  # prompt status symbol
  PS1="${PS1}${PS1_COLOR_BOLD}"
  if [[ -n "${DOT___IS_WSL}" ]] && command -v powershell.exe &>/dev/null && is-elevated-session; then
    # W* -- windows elevated session
    PS1="${PS1}${PS1_SYMBOL_WIN_PRIV}"
  elif [[ "$(id -u)" == 0 ]]; then
    PS1="${PS1}${PS1_SYMBOL_ROOT}"
  else
    PS1="${PS1}${PS1_SYMBOL_SU}"
  fi
  PS1="${PS1}${PS1_COLOR_RESET}"

  # terminal title + spacer
  echo "${PROMPT_TITLE}${PS1} "
}

# ------------------------------------------------------------------------------
# EXPORT PROMPTS
# ------------------------------------------------------------------------------
PS1="$(__ps1_create)"
export PS1

# export the sudo'd bash prompt
SUDO_PS1="$(__sudo_ps1_create)"
export SUDO_PS1

# export the interactive prompt line of the shell (→)
PS2="$(echo -e "\xe2\x86\x92") "
export PS2

# ---------- OTHER VARIABLES ----------

# show git status
export GIT_PS1_SHOWDIRTYSTATE=true
export GIT_PS1_SHOWSTASHSTATE=true
export GIT_PS1_SHOWUNTRACKEDFILES=true
export GIT_PS1_SHOWUPSTREAM="auto"

# ---------- CLEANUP ----------

# clean up functions
unset -f __ps1_create
unset -f __sudo_ps1_create

# unset variables so they don't leak out to the bash shell
unset -v \
  _PS1_SEGMENT_BG_JOBS \
  _PS1_SEGMENT_DATETIME \
  _PS1_SEGMENT_EXIT_STATUS \
  _PS1_SEGMENT_HOSTNAME \
  _PS1_SEGMENT_LOADAVG \
  _PS1_SEGMENT_PWD_WRITABLE \
  _PS1_SEGMENT_SESSION_TYPE \
  PS1_COLOR_BG_JOBS \
  PS1_COLOR_BOLD \
  PS1_COLOR_EXEC_TIME \
  PS1_COLOR_EXIT_ERROR \
  PS1_COLOR_GIT \
  PS1_COLOR_GREY \
  PS1_COLOR_HOST \
  PS1_COLOR_HOST_SCREEN \
  PS1_COLOR_LOAD \
  PS1_COLOR_NORMAL \
  PS1_COLOR_RESET \
  PS1_COLOR_TIME_DAY \
  PS1_COLOR_TIME_NIGHT \
  PS1_COLOR_UNDERLINE \
  PS1_COLOR_USER \
  PS1_COLOR_WORK_DIR \
  PS1_COLOR_WORK_DIRINFO \
  PS1_OPT_DAY_END \
  PS1_OPT_DAY_START \
  PS1_OPT_HIDE_DIR_INFO \
  PS1_OPT_HIDE_EXEC_TIME \
  PS1_OPT_HIDE_GIT \
  PS1_OPT_HIDE_LOAD \
  PS1_OPT_HIDE_TIME \
  PS1_OPT_MONOCHROME \
  PS1_OPT_MULTILINE \
  PS1_OPT_NEWLINE_THRESHOLD \
  PS1_OPT_SEGMENT_EXTRA \
  PS1_SYMBOL_GIT \
  PS1_SYMBOL_LOCAL \
  PS1_SYMBOL_NO_WRITE_PWD \
  PS1_SYMBOL_ROOT \
  PS1_SYMBOL_SSH \
  PS1_SYMBOL_SU \
  PS1_SYMBOL_USER \
  PS1_SYMBOL_WIN_PRIV \
  PROMPT_TITLE
