# shellcheck shell=bash
# Build and export the interactive shell prompt.
# SPDX-License-Identifier: MIT
# shellcheck disable=SC2154  # __dot_ps1_bold, __dot_ps1_reset set by dotenv/lib/prompt.sh

# ------------------------------------------------------------------------------
# DISABLE PROMPT
# ------------------------------------------------------------------------------
if [[ -n "${DOT_DISABLE_PS1:-}" ]]; then
  unset DOT_DISABLE_PS1
  return
fi

# ------------------------------------------------------------------------------
# SOURCE SUBSYSTEMS
# ------------------------------------------------------------------------------
# shellcheck source=/dev/null
source "${DOTFILES__ROOT}/.dotfiles/dotenv/lib/prompt-git.sh"
# shellcheck source=/dev/null
source "${DOTFILES__ROOT}/.dotfiles/dotenv/lib/prompt-exec-timer.sh"
# shellcheck source=/dev/null
source "${DOTFILES__ROOT}/.dotfiles/dotenv/lib/prompt-time.sh"
# shellcheck source=/dev/null
source "${DOTFILES__ROOT}/.dotfiles/dotenv/lib/prompt-loadavg.sh"

# ------------------------------------------------------------------------------
# STATIC ONE-TIME COMPUTATIONS
# ------------------------------------------------------------------------------

# session type symbol [@|#]
__dot_ps1_session_type="${DOT_PS1_SYMBOL_LOCAL:-#}"
if [[ -n "${DOT___IS_SSH}" ]]; then
  __dot_ps1_session_type="${DOT_PS1_SYMBOL_SSH:-@}"
fi

# WSL Administrator check (cache because powershell.exe is slow ~500ms)
__dot_ps1_win_elevated=""
if [[ -n "${DOT___IS_WSL}" ]] && command -v powershell.exe &>/dev/null && is-elevated-session; then
  __dot_ps1_win_elevated=1
fi

# hostname or session info -- color baked in at source time
internal::ps1-resolve-color DOT_PS1_COLOR_HOST '\[\e[38;5;208m\]' __dot_ps1_hostname_color
# shellcheck disable=SC2154
__dot_ps1_hostname_segment="${__dot_ps1_hostname_color}\h"
unset -v __dot_ps1_hostname_color
case "$TERM" in
  screen* | tmux*)
    internal::ps1-resolve-color DOT_PS1_COLOR_HOST_SCREEN '\[\e[4m\]\[\e[38;5;214m\]' __dot_ps1_screen_color
    if [[ -n "${TMUX:-}" ]]; then
      # shellcheck disable=SC2154
      __dot_ps1_hostname_segment="${__dot_ps1_screen_color}$([[ -n "${DOT___IS_SSH:-}" ]] && echo '\h,')$(tmux display-message -p '#S')[${TMUX_PANE}]"
    else
      __dot_ps1_hostname_segment="${__dot_ps1_screen_color}$([[ -n "${DOT___IS_SSH:-}" ]] && echo '\h,')${STY}[${WINDOW}]"
    fi
    unset -v __dot_ps1_screen_color
    ;;
esac

# OSC 8 hyperlink for the workdir segment.  Updated on each prompt so the
# URL reflects the current $PWD.  On WSL, paths under /mnt/[a-z]/ are
# converted to native Windows file:// URLs (file:///D:/...) since
# file://wsl.localhost/.../mnt/d/... gets access denied for Windows mounts.
__dot_ps1_osc8_dir_enabled=""
if [[ -z "${DOT_DISABLE_HYPERLINKS:-}" ]]; then
  if [[ -z "${DOT___IS_SSH:-}" ]] || [[ -n "${__dot_hyperlink_scheme}" ]]; then
    __dot_ps1_osc8_dir_enabled=1
  fi
fi

__dot_ps1_workdir_osc8_start=""
__dot_ps1_workdir_osc8_end=""
function internal::ps1-workdir-osc8-update() {
  [[ -n "${__dot_ps1_osc8_dir_enabled}" ]] || return 0
  local url
  if [[ -n "${DOT___IS_WSL:-}" ]] && [[ "$PWD" == /mnt/[a-z]/* ]]; then
    local drive="${PWD:5:1}"
    url="file:///${drive^}:${PWD:6}"
  elif [[ -n "${DOT___IS_WSL:-}" ]] && [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
    url="file://wsl.localhost/${WSL_DISTRO_NAME}${PWD}"
  else
    url="file://${HOSTNAME%%.*}${PWD}"
  fi
  __dot_ps1_workdir_osc8_start=$'\001\e]8;;'"${url}"$'\e\\\002'
  __dot_ps1_workdir_osc8_end=$'\001\e]8;;\e\\\002'
}
internal::ps1-workdir-osc8-update
internal::prompt-action-push internal::ps1-workdir-osc8-update

# Terminal title -- computed once and cached, recomputed on rebuild
function internal::ps1-resolve-title() {
  if [[ -n "${DOT_PS1_TITLE+x}" ]]; then
    __dot_ps1_title="${DOT_PS1_TITLE}"
  elif [[ -n "${PROMPT_TITLE+x}" ]]; then
    __dot_ps1_title="${PROMPT_TITLE}"
  else
    __dot_ps1_title=
    case "${TERM}" in
      xterm* | rxvt*)
        __dot_ps1_title="\[\e]0;\u@\h:\W\007\]"
        ;;
      screen* | tmux*)
        if [[ -n "${TMUX:-}" ]]; then
          __dot_ps1_title="\[\e]0;\u@\h:\W\007\]"
        else
          __dot_ps1_title="\[\e]0;\u@${STY}[${WINDOW}]:\W\007\]"
        fi
        ;;
    esac
  fi
}
internal::ps1-resolve-title

# Directory info caching
__dot_ps1_dirinfo=
function internal::ps1-dir-info-refresh() {
  [[ " ${DOT_PS1_SEGMENTS[*]} " == *' dirinfo '* ]] || return 0
  local lsout lssize
  local -a lines
  lsout=$(\ls -lAh 2>/dev/null) || return
  mapfile -t lines <<<"$lsout"
  lssize="${lines[0]#total }"
  __dot_ps1_dirinfo="<$((${#lines[@]} - 1))|${lssize}b>"
}
internal::array-append-unique chpwd_functions internal::ps1-dir-info-refresh

# Dynamic newline: re-evaluates on each prompt so terminal resize is respected
__dot_ps1_newline_threshold="${DOT_PS1_NEWLINE_THRESHOLD:-120}"
__dot_ps1_newline=""
function internal::ps1-newline-check() {
  if [[ ${COLUMNS:-0} -lt ${__dot_ps1_newline_threshold} ]]; then
    __dot_ps1_newline=$'\n'
  else
    __dot_ps1_newline=""
  fi
}
if [[ -z "${DOT_PS1_MULTILINE:-}" ]]; then
  internal::prompt-action-push internal::ps1-newline-check
fi

# Cache symbol values at source time for the build function
__dot_ps1_symbol_user="${DOT_PS1_SYMBOL_USER:-$'\xCE\xBB'}"
__dot_ps1_symbol_root="${DOT_PS1_SYMBOL_ROOT:-$'\xCE\xBC'}"
__dot_ps1_symbol_su="${DOT_PS1_SYMBOL_SU:-$'\xCF\x80'}"
__dot_ps1_symbol_win_priv="${DOT_PS1_SYMBOL_WIN_PRIV:-W*}"
__dot_ps1_multiline="${DOT_PS1_MULTILINE:-}"

# ------------------------------------------------------------------------------
# SEGMENT RENDER FUNCTIONS
# ------------------------------------------------------------------------------

# shellcheck disable=SC2016
function internal::ps1-render-exit_status() {
  local color
  internal::ps1-resolve-color DOT_PS1_COLOR_EXIT_ERROR '\[\e[38;5;196m\]' color
  echo "${color}"'$(EXIT="$?"; [[ $EXIT -ne 0 ]] && echo -n "(E:${EXIT}) ")'"${__dot_ps1_reset}"
}

# shellcheck disable=SC2016
function internal::ps1-render-bg_jobs() {
  local color
  internal::ps1-resolve-color DOT_PS1_COLOR_BG_JOBS '\[\e[38;5;042m\]' color
  echo "${color}"'$([[ \j -gt 0 ]] && echo -n "bg:\j ")'"${__dot_ps1_reset}"
}

function internal::ps1-render-time() {
  echo "\${__dot_ps1_time_segment}"
}

function internal::ps1-render-loadavg() {
  echo "\${__dot_ps1_loadavg_segment}"
}

function internal::ps1-render-user() {
  local color
  internal::ps1-resolve-color DOT_PS1_COLOR_USER '\[\e[38;5;197m\]' color
  echo "${color}\u${__dot_ps1_reset}"
}

function internal::ps1-render-session_host() {
  local grey
  internal::ps1-resolve-color DOT_PS1_COLOR_GREY '\[\e[38;5;244m\]' grey
  echo "${grey}${__dot_ps1_session_type}${__dot_ps1_reset}${__dot_ps1_hostname_segment}${__dot_ps1_reset} "
}

# shellcheck disable=SC2016,SC2028
# shellcheck disable=SC2016
function internal::ps1-render-workdir() {
  local color no_write_sym
  internal::ps1-resolve-color DOT_PS1_COLOR_WORK_DIR '\[\e[38;5;142m\]' color
  no_write_sym="${DOT_PS1_SYMBOL_NO_WRITE_PWD:-*}"
  local rw_check='$([[ ! -w "$PWD" ]] && echo -n "'"${no_write_sym}"'")'
  echo "${color}${rw_check}\${__dot_ps1_workdir_osc8_start}\\W\${__dot_ps1_workdir_osc8_end}${__dot_ps1_reset}"
}

function internal::ps1-render-dirinfo() {
  local color
  internal::ps1-resolve-color DOT_PS1_COLOR_WORK_DIRINFO '\[\e[38;5;035m\]' color
  echo "${color}\${__dot_ps1_dirinfo}${__dot_ps1_reset}"
}

function internal::ps1-render-git() {
  if [[ -z "${__dot_ps1_has_git:-}" ]]; then
    return
  fi
  local color
  internal::ps1-resolve-color DOT_PS1_COLOR_GIT '\[\e[38;5;135m\]' color
  echo "${color}\${__dot_ps1_git_segment}${__dot_ps1_reset}"
}

function internal::ps1-render-exec_time() {
  if [[ -n "${__dot_ps1_no_exec_timer:-}" ]]; then
    return
  fi
  local color
  internal::ps1-resolve-color DOT_PS1_COLOR_EXEC_TIME '\[\e[38;5;245m\]' color
  echo "${color}\${__dot_ps1_execduration}${__dot_ps1_reset}"
}

# ------------------------------------------------------------------------------
# PROMPT BUILD
# ------------------------------------------------------------------------------

# Build a PS1 string from a named segment array.
function internal::ps1-build() {
  local array_name="$1"
  local grey
  internal::ps1-resolve-color DOT_PS1_COLOR_GREY '\[\e[38;5;244m\]' grey

  local PS1=""

  PS1="${PS1}${__dot_ps1_bold}${grey}[${__dot_ps1_reset}"

  local -a segments=()
  eval "segments=(\"\${${array_name}[@]}\")"

  local seg fragment
  for seg in "${segments[@]}"; do
    fragment=""
    if declare -F "ps1_render_${seg}" &>/dev/null; then
      fragment="$("ps1_render_${seg}")"
    elif declare -F "internal::ps1-render-${seg}" &>/dev/null; then
      fragment="$("internal::ps1-render-${seg}")"
    fi
    PS1="${PS1}${fragment}"
  done

  PS1="${PS1}${__dot_ps1_bold}${grey}]${__dot_ps1_reset}"

  # newline before the user symbol
  if [[ -n "${__dot_ps1_multiline}" ]]; then
    PS1="${PS1}\n"
  elif [[ "$array_name" == "DOT_SUDO_PS1_SEGMENTS" ]]; then
    if [[ ${COLUMNS:-0} -lt ${__dot_ps1_newline_threshold} ]]; then
      PS1="${PS1}\n"
    fi
  else
    PS1="${PS1}\${__dot_ps1_newline}"
  fi

  # prompt status symbol
  PS1="${PS1}${__dot_ps1_bold}"
  if [[ -n "${__dot_ps1_win_elevated}" ]]; then
    PS1="${PS1}${__dot_ps1_symbol_win_priv}"
  elif [[ "$(id -u)" == 0 ]]; then
    PS1="${PS1}${__dot_ps1_symbol_root}"
  elif [[ "$array_name" == "DOT_SUDO_PS1_SEGMENTS" ]]; then
    PS1="${PS1}${__dot_ps1_symbol_su}"
  else
    PS1="${PS1}${__dot_ps1_symbol_user}"
  fi
  PS1="${PS1}${__dot_ps1_reset}"

  echo "${__dot_ps1_title}${PS1} "
}

# Rebuild PS1 and SUDO_PS1 from the current segment lists.
function internal::ps1-rebuild() {
  internal::ps1-time-config-refresh
  internal::ps1-loadavg-config-refresh
  internal::ps1-resolve-title
  internal::ps1-time-refresh
  if declare -F internal::ps1-proc-use &>/dev/null; then
    internal::ps1-loadavg-refresh
  fi
  PS1="$(internal::ps1-build DOT_PS1_SEGMENTS)"
  export PS1
  SUDO_PS1="$(internal::ps1-build DOT_SUDO_PS1_SEGMENTS)"
  export SUDO_PS1
}

# ------------------------------------------------------------------------------
# EXPORT PROMPTS
# ------------------------------------------------------------------------------
internal::ps1-rebuild

PS2="${DOT_PS2:-$'\xe2\x86\x92 '}"
if [[ -z "${DOT_PS4+x}" ]]; then
  PS4='+ ${BASH_SOURCE[0]:-shell}:${LINENO}${FUNCNAME[0]:+ ${FUNCNAME[0]}():} '
else
  PS4="${DOT_PS4}"
fi
export PS1 SUDO_PS1 PS2 PS4

export GIT_PS1_SHOWDIRTYSTATE=true
export GIT_PS1_SHOWSTASHSTATE=true
export GIT_PS1_SHOWUNTRACKEDFILES=true
export GIT_PS1_SHOWUPSTREAM="auto"

# ------------------------------------------------------------------------------
# CLEANUP
# ------------------------------------------------------------------------------
# User config vars are consumed at build time and should not leak into the
# environment.  Internal __dot_ps1_* state variables are kept so that
# internal::ps1-rebuild works at runtime.
unset -v \
  DOT_PS1_COLOR_BG_JOBS \
  DOT_PS1_COLOR_EXEC_TIME \
  DOT_PS1_COLOR_EXIT_ERROR \
  DOT_PS1_COLOR_GIT \
  DOT_PS1_COLOR_GREY \
  DOT_PS1_COLOR_HOST \
  DOT_PS1_COLOR_HOST_SCREEN \
  DOT_PS1_COLOR_LOAD \
  DOT_PS1_COLOR_TIME_DAY \
  DOT_PS1_COLOR_TIME_NIGHT \
  DOT_PS1_COLOR_USER \
  DOT_PS1_COLOR_WORK_DIR \
  DOT_PS1_COLOR_WORK_DIRINFO \
  DOT_PS1_DAY_END \
  DOT_PS1_DAY_START \
  DOT_PS1_MONOCHROME \
  DOT_PS1_MULTILINE \
  DOT_PS1_NEWLINE_THRESHOLD \
  DOT_PS1_SYMBOL_GIT \
  DOT_PS1_SYMBOL_LOCAL \
  DOT_PS1_SYMBOL_NO_WRITE_PWD \
  DOT_PS1_SYMBOL_ROOT \
  DOT_PS1_SYMBOL_SSH \
  DOT_PS1_SYMBOL_SU \
  DOT_PS1_SYMBOL_USER \
  DOT_PS1_SYMBOL_WIN_PRIV \
  DOT_PS1_TITLE \
  DOT_PS2 \
  DOT_PS4 \
  PROMPT_TITLE
