# shellcheck shell=bash
# Build and export the interactive shell prompt.
# SPDX-License-Identifier: MIT

# ------------------------------------------------------------------------------
# DISABLE PROMPT
# ------------------------------------------------------------------------------
if [[ -n "${DOT_DISABLE_PS1:-}" ]]; then
  unset DOT_DISABLE_PS1
  return
fi

# ------------------------------------------------------------------------------
# CONFIGURE PROMPT
# ------------------------------------------------------------------------------
# check if we can measure command execution time
# bash 5+ provides EPOCHREALTIME as a built-in; otherwise fall back to GNU date %N
if [[ -z "${EPOCHREALTIME:-}" ]]; then
  __dot_ps1_ns_check="$(date +%N)"
  if [[ -z "$__dot_ps1_ns_check" ]] || [[ "$__dot_ps1_ns_check" == "N" ]]; then
    PS1_OPT_HIDE_EXEC_TIME=1
  fi
  unset -v __dot_ps1_ns_check
fi

# bash 3 and below doesn't properly eacape the array when inlined
if [[ "${BASH_VERSION/.*/}" -lt 4 ]]; then
  PS1_COLOR_LOAD=('')
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
[[ -z "${PS1_COLOR_BG_JOBS+x}" ]] && PS1_COLOR_BG_JOBS='\[\e[38;5;042m\]'
[[ -z "${PS1_COLOR_EXEC_TIME+x}" ]] && PS1_COLOR_EXEC_TIME='\[\e[38;5;245m\]'
[[ -z "${PS1_COLOR_EXIT_ERROR+x}" ]] && PS1_COLOR_EXIT_ERROR='\[\e[38;5;196m\]'
[[ -z "${PS1_COLOR_GIT+x}" ]] && PS1_COLOR_GIT='\[\e[38;5;135m\]'
[[ -z "${PS1_COLOR_HOST_SCREEN+x}" ]] && PS1_COLOR_HOST_SCREEN=${PS1_COLOR_UNDERLINE}'\[\e[38;5;214m\]'
[[ -z "${PS1_COLOR_HOST+x}" ]] && PS1_COLOR_HOST='\[\e[38;5;208m\]'
[[ -z "${PS1_COLOR_TIME_DAY+x}" ]] && PS1_COLOR_TIME_DAY='\[\e[38;5;244m\]'
[[ -z "${PS1_COLOR_TIME_NIGHT+x}" ]] && PS1_COLOR_TIME_NIGHT='\[\e[38;5;033m\]'
[[ -z "${PS1_COLOR_USER+x}" ]] && PS1_COLOR_USER='\[\e[38;5;197m\]'
[[ -z "${PS1_COLOR_WORK_DIR+x}" ]] && PS1_COLOR_WORK_DIR='\[\e[38;5;142m\]'
[[ -z "${PS1_COLOR_WORK_DIRINFO+x}" ]] && PS1_COLOR_WORK_DIRINFO='\[\e[38;5;035m\]'

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
  PS1_COLOR_LOAD=('')
fi

# ------------------------------------------------------------------------------
# SYMBOLS AND VARIABLES FOR PROMPTS
# ------------------------------------------------------------------------------
[[ -z "${PS1_SYMBOL_NO_WRITE_PWD+x}" ]] && PS1_SYMBOL_NO_WRITE_PWD='*'
[[ -z "${PS1_SYMBOL_GIT+x}" ]] && PS1_SYMBOL_GIT="${PS1_COLOR_BOLD}"$'\xD5\xAF'"${PS1_COLOR_NORMAL} "
[[ -z "${PS1_SYMBOL_SSH+x}" ]] && PS1_SYMBOL_SSH='@'
[[ -z "${PS1_SYMBOL_LOCAL+x}" ]] && PS1_SYMBOL_LOCAL='#'

[[ -z "${PS1_SYMBOL_USER+x}" ]] && PS1_SYMBOL_USER=$'\xCE\xBB'  # λ
[[ -z "${PS1_SYMBOL_ROOT+x}" ]] && PS1_SYMBOL_ROOT=$'\xCE\xBC'  # μ
[[ -z "${PS1_SYMBOL_SU+x}" ]] && PS1_SYMBOL_SU=$'\xCF\x80'      # π
[[ -z "${PS1_SYMBOL_WIN_PRIV+x}" ]] && PS1_SYMBOL_WIN_PRIV="W*" # W*

[[ -z "${PS1_OPT_DAY_START+x}" ]] && PS1_OPT_DAY_START=8
[[ -z "${PS1_OPT_DAY_END+x}" ]] && PS1_OPT_DAY_END=18

[[ -z "${PS1_OPT_NEWLINE_THRESHOLD+x}" ]] && PS1_OPT_NEWLINE_THRESHOLD=120

# ------------------------------------------------------------------------------
# FUNCTIONS AND REUSED STATEMENTS FOR PROMPTS
# ------------------------------------------------------------------------------

# show the exit status of the previous command
# shellcheck disable=SC2016,SC2089
__dot_ps1_segment_exit_status='$(EXIT="$?"; [[ $EXIT -ne 0 ]] && echo -n "(E:${EXIT}) ")'

# show the number of running background jobs
# shellcheck disable=SC2016
__dot_ps1_segment_bg_jobs='$([[ \j -gt 0 ]] && echo -n "bg:\j ")'

# session type symbol [@|#]
__dot_ps1_segment_session_type="${PS1_SYMBOL_LOCAL}"
if [[ -n "${DOT___IS_SSH}" ]]; then
  __dot_ps1_segment_session_type="${PS1_SYMBOL_SSH}"
fi

# wsl Administrator check
__dot_ps1_segment_win_elevated=""
# minor optimization, calls to powershell is slow ~500ms, so cache value of is-elevated-session
if [[ -n "${DOT___IS_WSL}" ]] && command -v powershell.exe &>/dev/null && is-elevated-session; then
  # W* -- windows elevated session
  __dot_ps1_segment_win_elevated=1
fi

# show icon if the directory is not writable for the user
# shellcheck disable=SC2016
__dot_ps1_segment_pwd_writable='$([[ ! -w "$PWD" ]] && echo -n "'${PS1_SYMBOL_NO_WRITE_PWD}'")'

# hostname or session info
__dot_ps1_segment_hostname="${PS1_COLOR_HOST}\h"
case "$TERM" in
  screen*)
    if [[ -n "${TMUX:-}" ]]; then
      __dot_ps1_segment_hostname="${PS1_COLOR_HOST_SCREEN}$([[ -n "${DOT___IS_SSH:-}" ]] && echo '\h,')$(tmux display-message -p '#S')[${TMUX_PANE}]"
    else
      __dot_ps1_segment_hostname="${PS1_COLOR_HOST_SCREEN}$([[ -n "${DOT___IS_SSH:-}" ]] && echo '\h,')${STY}[${WINDOW}]"
    fi
    ;;
esac

# PROMPT_TITLE -- Set the title bar if we are in xterm
if declare -p PROMPT_TITLE &>/dev/null; then
  __dot_ps1_title="${PROMPT_TITLE}"
else
  __dot_ps1_title=
  case "${TERM}" in
    xterm* | rxvt*)
      __dot_ps1_title="\[\e]0;\u@\h:\W\007\]"
      ;;
    screen*)
      if [[ -n "${TMUX:-}" ]]; then
        __dot_ps1_title="\[\e]0;\u@\h:\W\007\]"
      else
        __dot_ps1_title="\[\e]0;\u@${STY}[${WINDOW}]:\W\007\]"
      fi
      ;;
  esac
fi

# show time with color highlight
# shellcheck disable=SC2016
__dot_ps1_segment_datetime="$(tr -d '\n' <<<'
  printf -v time "%(%H)T" -1;
  time=${time#0};
  color="'"${PS1_COLOR_TIME_NIGHT}"'";
  if [[ ${time} -ge '"${PS1_OPT_DAY_START}"' && ${time} -le '"${PS1_OPT_DAY_END}"' ]]; then
     color="'"${PS1_COLOR_TIME_DAY}"'";
  fi;
  echo "${color}\T'"${PS1_COLOR_RESET}"' "
')"

# show load average with highlight
# shellcheck disable=SC2016,SC2046
__dot_ps1_segment_loadavg="$(tr -d '\n' <<<'
  load=$(internal::ps1-proc-use);
  loadcolors=('$(printf "'%s' " "${PS1_COLOR_LOAD[@]}")');
  __dot_ps1_loadmod="${load%%.*}";
  [[ -z "${__dot_ps1_loadmod}" ]] && __dot_ps1_loadmod=0;
  [[ "${__dot_ps1_loadmod}" -gt '$((${#PS1_COLOR_LOAD[@]} - 1))' ]] && __dot_ps1_loadmod='$((${#PS1_COLOR_LOAD[@]} - 1))';
  echo "${loadcolors[$__dot_ps1_loadmod]}${load}'"${PS1_COLOR_RESET}"' ";
')"

# caching the directory information for bash prompt to reduce disk reads
if [[ -z "${PS1_OPT_HIDE_DIR_INFO:-}" ]]; then
  __dot_ps1_dirinfo=
  function internal::ps1-dir-info-refresh() {
    local lsout lssize
    local -a lines
    lsout=$(\ls -lAh 2>/dev/null) || return
    mapfile -t lines <<<"$lsout"
    lssize="${lines[0]#total }"
    __dot_ps1_dirinfo="<$((${#lines[@]} - 1))|${lssize}b>"
  }
  chpwd_functions+=(internal::ps1-dir-info-refresh)
fi

# show information about the last process
if [[ -z "${PS1_OPT_HIDE_EXEC_TIME:-}" ]]; then
  __dot_ps1_exectimer=0
  __dot_ps1_execduration=
  if [[ -n "${EPOCHREALTIME:-}" ]]; then
    # bash 5+: built-in microsecond timer (no fork per command)
    function internal::ps1-exec-timer-start() {
      [[ __dot_ps1_exectimer -gt 0 ]] && return
      __dot_ps1_exectimer="${EPOCHREALTIME/./}"
    }
  else
    function internal::ps1-exec-timer-start() {
      [[ __dot_ps1_exectimer -gt 0 ]] && return
      __dot_ps1_exectimer=$(date +%s%N)
    }
  fi
  preexec_functions+=(internal::ps1-exec-timer-start)

  function internal::ps1-exec-timer-stop() {
    if [[ __dot_ps1_exectimer -eq 0 ]]; then
      __dot_ps1_execduration=
      return
    fi
    local duration delta_us
    if [[ -n "${EPOCHREALTIME:-}" ]]; then
      delta_us=$((${EPOCHREALTIME/./} - __dot_ps1_exectimer))
    else
      delta_us=$((($(date +%s%N) - __dot_ps1_exectimer) / 1000))
    fi
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

    __dot_ps1_exectimer=0
    __dot_ps1_execduration=" ${duration}"
  }
  internal::prompt-action-push internal::ps1-exec-timer-stop
fi

# dynamic newline: re-evaluates on each prompt so terminal resize is respected
if [[ -z "${PS1_OPT_MULTILINE:-}" ]]; then
  __dot_ps1_newline_threshold="${PS1_OPT_NEWLINE_THRESHOLD:-120}"
  __dot_ps1_newline=""
  function internal::ps1-newline-check() {
    if [[ ${COLUMNS:-0} -lt ${__dot_ps1_newline_threshold} ]]; then
      __dot_ps1_newline=$'\n'
    else
      __dot_ps1_newline=""
    fi
  }
  internal::prompt-action-push internal::ps1-newline-check
fi

# git prompt segment caching
[[ -z "${DOT_GIT_PROMPT_CACHE_TTL_MS+x}" ]] && DOT_GIT_PROMPT_CACHE_TTL_MS=1000
[[ -z "${DOT_GIT_PROMPT_CACHE_MAX_AGE_MS+x}" ]] && DOT_GIT_PROMPT_CACHE_MAX_AGE_MS=10000
[[ -z "${DOT_GIT_PROMPT_INVALIDATE_ON_GIT+x}" ]] && DOT_GIT_PROMPT_INVALIDATE_ON_GIT=1
__dot_ps1_git_format=" (${PS1_SYMBOL_GIT}${PS1_COLOR_RESET}${PS1_COLOR_GIT}%s)"

# Timestamp in milliseconds.
function internal::ps1-git-now-ms() {
  if [[ -n "${EPOCHREALTIME:-}" ]]; then
    echo "$((${EPOCHREALTIME/./} / 1000))"
  else
    echo "$((SECONDS * 1000))"
  fi
}

# Cross-platform mtime helper (seconds since epoch).
function internal::ps1-git-mtime() {
  local path="$1"
  local mtime
  [[ -e "$path" ]] || {
    echo 0
    return
  }
  if mtime="$(stat -f %m "$path" 2>/dev/null)"; then
    echo "$mtime"
    return
  fi
  if mtime="$(stat -c %Y "$path" 2>/dev/null)"; then
    echo "$mtime"
    return
  fi
  echo 0
}

# Resolve current repository gitdir by walking from $PWD upward.
function internal::ps1-gitdir() {
  local dir="$PWD"
  local dotgit line gitdir
  while true; do
    dotgit="${dir}/.git"
    if [[ -d "$dotgit" ]]; then
      echo "$dotgit"
      return 0
    fi
    if [[ -f "$dotgit" ]]; then
      IFS= read -r line <"$dotgit" || return 1
      case "$line" in
        "gitdir: "*)
          gitdir="${line#gitdir: }"
          if [[ "$gitdir" != /* ]]; then
            gitdir="${dir}/${gitdir}"
          fi
          if [[ -d "$gitdir" ]]; then
            echo "$gitdir"
            return 0
          fi
          ;;
      esac
      return 1
    fi
    [[ "$dir" == "/" ]] && break
    dir="${dir%/*}"
    [[ -z "$dir" ]] && dir="/"
  done
  return 1
}

# Invalidate cached git prompt state.
function internal::ps1-git-cache-invalidate() {
  __dot_ps1_git_cache_pwd=
  __dot_ps1_git_cache_last_check_ms=0
  __dot_ps1_git_cache_last_refresh_ms=0
  __dot_ps1_git_cache_gitdir=
  __dot_ps1_git_cache_head_mtime=0
  __dot_ps1_git_cache_index_mtime=0
  __dot_ps1_git_cache_stash_mtime=0
  __dot_ps1_git_cache_segment=
}
internal::ps1-git-cache-invalidate
chpwd_functions+=(internal::ps1-git-cache-invalidate)

# Mark git prompt cache as dirty when the next command appears git-related.
function internal::ps1-git-preexec-mark-dirty() {
  [[ "${DOT_GIT_PROMPT_INVALIDATE_ON_GIT:-1}" == 0 ]] && return

  local cmd="${1:-}" token
  cmd="${cmd#"${cmd%%[![:space:]]*}"}"
  token="${cmd%%[[:space:];|&]*}"
  case "$token" in
    git | */git)
      __dot_ps1_git_cache_dirty=1
      ;;
    command | builtin | env)
      cmd="${cmd#"$token"}"
      cmd="${cmd#"${cmd%%[![:space:]]*}"}"
      token="${cmd%%[[:space:];|&]*}"
      if [[ "$token" == git ]] || [[ "$token" == */git ]]; then
        __dot_ps1_git_cache_dirty=1
      fi
      ;;
    sudo)
      cmd="${cmd#"$token"}"
      if [[ "$cmd" =~ (^|[[:space:]])(git|[^[:space:]]*/git)([[:space:];|&]|$) ]]; then
        __dot_ps1_git_cache_dirty=1
      fi
      ;;
  esac
}
preexec_functions+=(internal::ps1-git-preexec-mark-dirty)

# Update cached git prompt state before PS1 is rendered.
# Check once at setup time whether __git_ps1 is available, avoiding a fork on every prompt render.
if command -v __git_ps1 &>/dev/null; then
  __dot_ps1_has_git=1
else
  __dot_ps1_has_git=
fi
__dot_ps1_git_segment=
function internal::ps1-git-update() {
  if [[ -z "${__dot_ps1_has_git:-}" ]]; then
    __dot_ps1_git_segment=
    return
  fi

  if [[ -n "${__dot_ps1_git_cache_dirty:-}" ]]; then
    internal::ps1-git-cache-invalidate
    unset __dot_ps1_git_cache_dirty
  fi

  local now_ms ttl_ms max_age_ms
  now_ms="$(internal::ps1-git-now-ms)"
  ttl_ms="${DOT_GIT_PROMPT_CACHE_TTL_MS:-1000}"
  max_age_ms="${DOT_GIT_PROMPT_CACHE_MAX_AGE_MS:-10000}"
  [[ "$ttl_ms" =~ ^[0-9]+$ ]] || ttl_ms=1000
  [[ "$max_age_ms" =~ ^[0-9]+$ ]] || max_age_ms=10000

  if [[ "${__dot_ps1_git_cache_pwd:-}" == "$PWD" ]] \
    && ((now_ms - __dot_ps1_git_cache_last_check_ms < ttl_ms)); then
    __dot_ps1_git_segment="${__dot_ps1_git_cache_segment:-}"
    return
  fi

  local gitdir
  if ! gitdir="$(internal::ps1-gitdir)"; then
    internal::ps1-git-cache-invalidate
    __dot_ps1_git_cache_pwd="$PWD"
    __dot_ps1_git_cache_last_check_ms="$now_ms"
    __dot_ps1_git_segment=
    return
  fi

  local head_mtime index_mtime stash_mtime
  head_mtime="$(internal::ps1-git-mtime "${gitdir}/HEAD")"
  index_mtime="$(internal::ps1-git-mtime "${gitdir}/index")"
  stash_mtime="$(internal::ps1-git-mtime "${gitdir}/refs/stash")"

  if [[ "${__dot_ps1_git_cache_gitdir:-}" == "$gitdir" ]] \
    && [[ "${__dot_ps1_git_cache_head_mtime:-0}" == "$head_mtime" ]] \
    && [[ "${__dot_ps1_git_cache_index_mtime:-0}" == "$index_mtime" ]] \
    && [[ "${__dot_ps1_git_cache_stash_mtime:-0}" == "$stash_mtime" ]] \
    && ((now_ms - __dot_ps1_git_cache_last_refresh_ms < max_age_ms)); then
    __dot_ps1_git_cache_pwd="$PWD"
    __dot_ps1_git_cache_last_check_ms="$now_ms"
    __dot_ps1_git_segment="${__dot_ps1_git_cache_segment:-}"
    return
  fi

  local segment segment_render
  segment="$(__git_ps1 "${__dot_ps1_git_format}")"
  # __git_ps1 returns PS1-style escapes (\[...\]); when stored in a variable
  # we need prompt-ready control chars so readline tracks visual width correctly.
  segment_render="${segment//\\[/$'\001'}"
  segment_render="${segment_render//\\]/$'\002'}"
  segment_render="$(printf '%b' "$segment_render")"
  __dot_ps1_git_cache_pwd="$PWD"
  __dot_ps1_git_cache_last_check_ms="$now_ms"
  __dot_ps1_git_cache_last_refresh_ms="$now_ms"
  __dot_ps1_git_cache_gitdir="$gitdir"
  __dot_ps1_git_cache_head_mtime="$head_mtime"
  __dot_ps1_git_cache_index_mtime="$index_mtime"
  __dot_ps1_git_cache_stash_mtime="$stash_mtime"
  __dot_ps1_git_cache_segment="$segment_render"
  __dot_ps1_git_segment="$segment_render"
}
internal::ps1-git-update
internal::prompt-action-push internal::ps1-git-update

# ------------------------------------------------------------------------------
# PROMPT GENERATION
# ------------------------------------------------------------------------------
# generate the bash prompt
function internal::ps1-create() {
  local PS1=""

  # [ -- open bracket
  PS1="${PS1}${PS1_COLOR_BOLD}${PS1_COLOR_GREY}[${PS1_COLOR_RESET}"

  # (E:1) -- exit code
  PS1="${PS1}${PS1_COLOR_EXIT_ERROR}${__dot_ps1_segment_exit_status}${PS1_COLOR_RESET}"

  # bg:1 -- number of background jobs
  PS1="${PS1}${PS1_COLOR_BG_JOBS}${__dot_ps1_segment_bg_jobs}${PS1_COLOR_RESET}"

  # time
  if [[ -z "${PS1_OPT_HIDE_TIME:-}" ]]; then
    PS1="${PS1}\$(${__dot_ps1_segment_datetime})"
  fi

  # load average
  if [[ -z "${PS1_OPT_HIDE_LOAD:-}" ]]; then
    PS1="${PS1}\$(${__dot_ps1_segment_loadavg})"
  fi

  # current user
  PS1="${PS1}${PS1_COLOR_USER}\u${PS1_COLOR_RESET}"

  # @|# - session type
  PS1="${PS1}${PS1_COLOR_GREY}${__dot_ps1_segment_session_type}${PS1_COLOR_RESET}"
  # hostname or session info
  PS1="${PS1}${__dot_ps1_segment_hostname}${PS1_COLOR_RESET} "

  # working directory
  PS1="${PS1}${PS1_COLOR_WORK_DIR}${__dot_ps1_segment_pwd_writable}\W${PS1_COLOR_RESET}"

  # working directory information (number of files | total file size)
  if [[ -z "${PS1_OPT_HIDE_DIR_INFO:-}" ]]; then
    PS1="${PS1}${PS1_COLOR_WORK_DIRINFO}\${__dot_ps1_dirinfo}${PS1_COLOR_RESET}"
  fi

  # git status only if the git repo status function is installed
  if [[ -z "${PS1_OPT_HIDE_GIT:-}" ]] && command -v __git_ps1 &>/dev/null; then
    PS1="${PS1}${PS1_COLOR_GIT}\${__dot_ps1_git_segment}${PS1_COLOR_RESET}"
  fi

  # any additional blocks from the local prompt config
  if [[ -n "${PS1_OPT_SEGMENT_EXTRA:-}" ]]; then
    PS1="${PS1}${PS1_OPT_SEGMENT_EXTRA}${PS1_COLOR_RESET}"
  fi

  # process information
  if [[ -z "${PS1_OPT_HIDE_EXEC_TIME:-}" ]]; then
    PS1="${PS1}${PS1_COLOR_EXEC_TIME}\${__dot_ps1_execduration}${PS1_COLOR_RESET}"
  fi

  # ] -- close bracket
  PS1="${PS1}${PS1_COLOR_BOLD}${PS1_COLOR_GREY}]${PS1_COLOR_RESET}"

  # newline before the user symbol if necessary
  if [[ -n "${PS1_OPT_MULTILINE:-}" ]]; then
    PS1="${PS1}\n"
  else
    PS1="${PS1}\${__dot_ps1_newline}"
  fi

  # prompt status symbol
  PS1="${PS1}${PS1_COLOR_BOLD}"
  if [[ -n "${__dot_ps1_segment_win_elevated}" ]]; then
    # W* -- windows elevated session
    PS1="${PS1}${PS1_SYMBOL_WIN_PRIV}"
  elif [[ "$(id -u)" == 0 ]]; then
    PS1="${PS1}${PS1_SYMBOL_ROOT}"
  else
    PS1="${PS1}${PS1_SYMBOL_USER}"
  fi
  PS1="${PS1}${PS1_COLOR_RESET}"

  # terminal title + spacer
  echo "${__dot_ps1_title}${PS1} "
}

# generate the sudo bash prompt
function internal::sudo-ps1-create() {
  local PS1=""

  # [ -- open bracket
  PS1="${PS1}${PS1_COLOR_BOLD}${PS1_COLOR_GREY}[${PS1_COLOR_RESET}"
  # (E:1) -- exit code
  PS1="${PS1}${PS1_COLOR_EXIT_ERROR}${__dot_ps1_segment_exit_status}${PS1_COLOR_RESET}"
  # bg:1 -- number of background jobs
  PS1="${PS1}${PS1_COLOR_BG_JOBS}${__dot_ps1_segment_bg_jobs}${PS1_COLOR_RESET}"
  # time
  if [[ -z "${PS1_OPT_HIDE_TIME:-}" ]]; then
    PS1="${PS1}\$(${__dot_ps1_segment_datetime})"
  fi
  # current user
  PS1="${PS1}${PS1_COLOR_USER}\u${PS1_COLOR_RESET}"
  # @|# - session type
  PS1="${PS1}${PS1_COLOR_GREY}${__dot_ps1_segment_session_type}${PS1_COLOR_RESET}"
  # hostname or session info
  PS1="${PS1}${__dot_ps1_segment_hostname}${PS1_COLOR_RESET} "
  # working directory
  PS1="${PS1}${PS1_COLOR_WORK_DIR}${__dot_ps1_segment_pwd_writable}\W${PS1_COLOR_RESET}"
  # ] -- close bracket
  PS1="${PS1}${PS1_COLOR_BOLD}${PS1_COLOR_GREY}]${PS1_COLOR_RESET}"

  # newline before the user symbol if necessary
  if [[ -n "${PS1_OPT_MULTILINE:-}" ]]; then
    PS1="${PS1}\n"
  elif [[ ${COLUMNS:-0} -lt ${PS1_OPT_NEWLINE_THRESHOLD} ]]; then
    PS1="${PS1}\n"
  fi

  # prompt status symbol
  PS1="${PS1}${PS1_COLOR_BOLD}"
  if [[ -n "${__dot_ps1_segment_win_elevated}" ]]; then
    # W* -- windows elevated session
    PS1="${PS1}${PS1_SYMBOL_WIN_PRIV}"
  elif [[ "$(id -u)" == 0 ]]; then
    PS1="${PS1}${PS1_SYMBOL_ROOT}"
  else
    PS1="${PS1}${PS1_SYMBOL_SU}"
  fi
  PS1="${PS1}${PS1_COLOR_RESET}"

  # terminal title + spacer
  echo "${__dot_ps1_title}${PS1} "
}

# ------------------------------------------------------------------------------
# EXPORT PROMPTS
# ------------------------------------------------------------------------------
PS1="$(internal::ps1-create)"
export PS1

# export the sudo'd bash prompt
SUDO_PS1="$(internal::sudo-ps1-create)"
export SUDO_PS1

# export the interactive prompt line of the shell (→)
PS2=$'\xe2\x86\x92 '
export PS2

# ---------- OTHER VARIABLES ----------

# show git status
export GIT_PS1_SHOWDIRTYSTATE=true
export GIT_PS1_SHOWSTASHSTATE=true
export GIT_PS1_SHOWUNTRACKEDFILES=true
export GIT_PS1_SHOWUPSTREAM="auto"

# ---------- CLEANUP ----------

# clean up functions
unset -f internal::ps1-create
unset -f internal::sudo-ps1-create

# unset variables so they don't leak out to the bash shell
unset -v \
  __dot_ps1_segment_bg_jobs \
  __dot_ps1_segment_datetime \
  __dot_ps1_segment_exit_status \
  __dot_ps1_segment_hostname \
  __dot_ps1_segment_loadavg \
  __dot_ps1_segment_pwd_writable \
  __dot_ps1_segment_session_type \
  __dot_ps1_segment_win_elevated \
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
  PROMPT_TITLE \
  __dot_ps1_title
