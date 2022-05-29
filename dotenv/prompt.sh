# shellcheck shell=bash
# ---------- COLOR REFERENCES AND OPTIONS ----------

if [[ -n "${_PS1_DISABLED:-}" ]]; then
  unset _PS1_DISABLED
  return
fi

# quick reference to colors
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
PS1_COLOR_HOST_SCREEN=${PS1_COLOR_UNDERLINE}'\[\e[38;5;214m\]'
PS1_COLOR_WORK_DIR='\[\e[38;5;142m\]'
PS1_COLOR_WORK_DIRINFO='\[\e[38;5;35m\]'
PS1_COLOR_GIT='\[\e[38;5;135m\]'
PS1_COLOR_EXEC_TIME='\[\e[38;5;245m\]'
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

# If we want a monochrome bash prompt
if [[ -n "${_PS1_MONOCHROME:-}" ]]; then
  # quick reference to colors
  PS1_COLOR_GREY=

  # colors for individual parts of the bash prompt
  PS1_COLOR_EXIT_ERROR=
  PS1_COLOR_BG_JOBS=
  PS1_COLOR_USER=
  PS1_COLOR_HOST=
  PS1_COLOR_HOST_SCREEN=${PS1_COLOR_UNDERLINE}
  PS1_COLOR_WORK_DIR=
  PS1_COLOR_WORK_DIRINFO=
  PS1_COLOR_GIT=
  PS1_COLOR_TIME_AM=
  PS1_COLOR_TIME_PM=

  # load avg colorization
  PS1_COLOR_LOAD='
    loadcolors_0=""
    loadcolors_1=""
    loadcolors_2=""
    loadcolors_3=""
    loadcolors_4=""
    loadcolors_5=""
    loadcolors_6=""
    loadcolors_7=""
    loadcolors_8=""
    loadcolors_9=""
  '
fi
PS1_COLOR_LOAD="$(tr -d '\n' <<<"${PS1_COLOR_LOAD}")"

# ---------- SYMBOLS AND VARIABLES FOR PROMPTS ----------

PS1_SYMBOL_NO_WRITE_PWD='*'
PS1_SYMBOL_GIT_BRANCH="${PS1_COLOR_BOLD}$(echo -e '\xD5\xAF')${PS1_COLOR_NORMAL} "
PS1_SYMBOL_SSH='@'
PS1_SYMBOL_LOCAL='#'

PS1_SYMBOL_USER="$(echo -e "\xCE\xBB")"
PS1_SYMBOL_ROOT="$(echo -e "\xCE\xBC")"
PS1_SYMBOL_SU="$(echo -e "\xCF\x80\x0A")"

PS1_DAY_START=8
PS1_DAY_END=18

# ---------- SYMBOL, VARIABLES, AND COLOR OVERRIDES ----------

# shellcheck source=/dev/null
[[ -r "${HOME}/.prompt_exports" ]] && source "${HOME}/.prompt_exports"

# ---------- FUNCTIONS AND REUSED STATEMENTS FOR PROMPTS ----------

# Keep a cached date variable for prompt testing
# shellcheck disable=SC2016
__push_internal_prompt_command '__ps1_var_date=$(/bin/date +%s)'

if [[ -z "${_PS1_HIDE_LOAD:-}" ]]; then
  # shellcheck disable=SC2016
  PS1_LOAD_AVG='load=$(__ps1_proc_use)'

  # special case for osx systems with older sed
  case ${DOTENV} in
    linux)
      # shellcheck disable=SC2016
      PS1_LOAD_AVG=${PS1_LOAD_AVG}'
          __ps1_var_loadmod=$(echo "${load}" | \\sed "s/^0*\\([0-9]\\+\\)\\..\\+\\$/\\1/")
        '
      ;;
    darwin)
      # shellcheck disable=SC2016
      PS1_LOAD_AVG=${PS1_LOAD_AVG}'
          __ps1_var_loadmod=$(echo "${load}" | \\sed "s/^0*\\([0-9][0-9]*\\)\\..*\\$/\\1/")
        '
      ;;
  esac

  # shellcheck disable=SC2016
  PS1_LOAD_AVG=${PS1_LOAD_AVG}${PS1_COLOR_LOAD}';
      [[ $__ps1_var_loadmod -gt 9 ]] && __ps1_var_loadmod=9;
      loadcolor="loadcolors_${__ps1_var_loadmod}";
      echo "${!loadcolor}${load}'${PS1_COLOR_RESET}' ";
    '
  PS1_LOAD_AVG="$(tr -d '\n' <<<"${PS1_LOAD_AVG}")"
fi

# caching the directory information for bash prompt to reduce disk reads
if [[ -z "${_PS1_HIDE_DIR_INFO:-}" ]]; then
  __ps1_var_dirinfo="0|0b"
  __ps1_var_dirinfotime=0
  __ps1_var_dirinfoprev=0
  [[ -z ${__ps1_var_dirinforeloadtime} ]] && __ps1_var_dirinforeloadtime=60
  function __ps1_dir_wrapper() {
    local lsout lsnum lssize

    # refresh every minute or on directory change
    if [[ $((__ps1_var_date - __ps1_var_dirinforeloadtime)) -gt ${__ps1_var_dirinfotime} || "${PWD}" != "${__ps1_var_dirinfoprev}" ]]; then
      lsout=$(/bin/ls -lAh 2>/dev/null)
      lsnum=$(($(echo "${lsout}" | \wc -l | \sed "s/ //g") - 1))
      lssize="$(echo "${lsout}" | \grep '^total ' | \sed 's/^total //')b"

      __ps1_var_dirinfo="${lsnum}|${lssize}"
      __ps1_var_dirinfoprev="${PWD}"
      __ps1_var_dirinfotime=$(/bin/date +%s)
      # update the prompt time
      __ps1_var_date=${__ps1_var_dirinfotime}
    fi
  }

  __push_internal_prompt_command __ps1_dir_wrapper
fi

# datetime colorization in prompt
if [[ -z "${_PS1_HIDE_TIME:-}" ]]; then
  # shellcheck disable=SC2016,SC2086
  PS1_DATETIME="$(tr -d '\n' <<<'
  time=$(/bin/date +"%H" | sed 's/^0//');
  color="'${PS1_COLOR_TIME_PM}'";
  if [[ ${time} -ge '${PS1_DAY_START}' && ${time} -le '${PS1_DAY_END}' ]]; then
     color="'${PS1_COLOR_TIME_AM}'";
  fi;
  echo "${color}\T'${PS1_COLOR_RESET}' "
')"
fi

# show icon if the directory is not writable for the user
# shellcheck disable=SC2016
PS1_PWD_WRITABLE='$([[ ! -w "$PWD" ]] && echo -n "'${PS1_SYMBOL_NO_WRITE_PWD}'")'

# show the exit status of the previous command
# shellcheck disable=SC2016,SC2089
PS1_EXIT_STATUS='$(EXIT="$?"; [[ $EXIT -ne 0 ]] && echo -n "(E:${EXIT}) ")'

# show information about the last process
if [[ -z "${_PS1_HIDE_EXEC_TIME:-}" ]]; then
  __ps1_var_exectimer=0
  __ps1_var_execduration=
  function __ps1_exec_timer_start {
    if [[ __ps1_var_exectimer -gt 0 ]]; then
      return 0
    fi
    __ps1_var_exectimer=$(date +%s%N)
  }
  trap '__ps1_exec_timer_start' DEBUG

  function __ps1_exec_timer_stop {
    local delta_us=$((($(date +%s%N) - __ps1_var_exectimer) / 1000))
    local us=$((delta_us % 1000))
    local ms=$(((delta_us / 1000) % 1000))
    local s=$(((delta_us / 1000000) % 60))
    local m=$(((delta_us / 60000000) % 60))
    local h=$((delta_us / 3600000000))
    if ((h > 0)); then
      __ps1_var_execduration=${h}h${m}m
    elif ((m > 0)); then
      __ps1_var_execduration=${m}m${s}s
    elif ((s >= 10)); then
      __ps1_var_execduration=${s}.$((ms / 100))s
    elif ((s > 0)); then
      __ps1_var_execduration=${s}.$(printf %03d $ms)s
    elif ((ms >= 100)); then
      __ps1_var_execduration=${ms}ms
    elif ((ms > 0)); then
      __ps1_var_execduration=${ms}.$((us / 100))ms
    else
      __ps1_var_execduration=${us}us
    fi
    __ps1_var_exectimer=0
  }
  __push_internal_prompt_command __ps1_exec_timer_stop

  # shellcheck disable=SC2016
  PS1_EXEC_TIME='$(echo "${__ps1_var_execduration}")'
fi

# show the number of running background jobs
# shellcheck disable=SC2016
PS1_BG_JOBS='$([[ \j -gt 0 ]] && echo -n "bg:\j ")'

# [@|#] based on environment If ssh connection
if [[ -n "${IS_SSH:-}" ]]; then
  PS1_SESSION_TYPE="${PS1_SYMBOL_SSH}"
else
  # otherwise
  PS1_SESSION_TYPE="${PS1_SYMBOL_LOCAL}"
fi

# [host|screen session]
case "$TERM" in
  screen*)
    if [[ -n "${TMUX}" ]]; then
      PS1_HOST_NAME="${PS1_COLOR_HOST_SCREEN}$(test -n "${SSH_CONNECTION:-}" && echo '\h,')$(tmux display-message -p '#S')[${TMUX_PANE}]"
    else
      PS1_HOST_NAME="${PS1_COLOR_HOST_SCREEN}$(test -n "${SSH_CONNECTION:-}" && echo '\h,')${STY}[${WINDOW}]"
    fi
    ;;
  *)
    PS1_HOST_NAME="${PS1_COLOR_HOST}"'\h'
    ;;
esac

# Set the title bar if we are in xterm
case "${TERM}" in
  xterm* | rxvt*)
    PROMPT_TITLE="\[\e]0;\u@\h:\W\007\]"
    ;;
  screen*)
    if [[ -n "${TMUX}" ]]; then
      PROMPT_TITLE="\[\e]0;\u@\h:\W\007\]"
    else
      PROMPT_TITLE="\[\e]0;\u@${STY}[${WINDOW}]:\W\007\]"
    fi
    ;;
  *)
    PROMPT_TITLE=""
    ;;
esac

# ---------- PROMPT GENERATION ----------

# generate the bash prompt
function __ps1_create() {
  # Start PS1 description
  PS1=''
  # open bracket
  PS1="${PS1}""${PS1_COLOR_BOLD}${PS1_COLOR_GREY}"'['"${PS1_COLOR_RESET}"
  # show exit code
  PS1="${PS1}""${PS1_COLOR_EXIT_ERROR}${PS1_EXIT_STATUS}${PS1_COLOR_RESET}"
  # show number of background jobs
  PS1="${PS1}""${PS1_COLOR_BG_JOBS}${PS1_BG_JOBS}${PS1_COLOR_RESET}"
  # time
  if [[ -z "${_PS1_HIDE_TIME:-}" ]]; then
    PS1="${PS1}\$(${PS1_DATETIME})"
  fi
  # load
  if [[ -z "${_PS1_HIDE_LOAD:-}" ]]; then
    PS1="${PS1}\$(${PS1_LOAD_AVG})"
  fi
  # user
  PS1="${PS1}""${PS1_COLOR_USER}"'\u'"${PS1_COLOR_RESET}"
  # [@] based on environment
  PS1=${PS1}${PS1_COLOR_GREY}${PS1_SESSION_TYPE}${PS1_COLOR_RESET}
  # [host|screen session] + space
  PS1=${PS1}${PS1_HOST_NAME}${PS1_COLOR_RESET}' '
  # working directory
  PS1="${PS1}""${PS1_COLOR_WORK_DIR}${PS1_PWD_WRITABLE}"'\W'"${PS1_COLOR_RESET}"
  # working directory information (number of files | total file size)
  if [[ -z "${_PS1_HIDE_DIR_INFO:-}" ]]; then
    PS1="${PS1}""${PS1_COLOR_WORK_DIRINFO}"'<${__ps1_var_dirinfo}>'"${PS1_COLOR_RESET}"
  fi
  # any additional blocks from the local prompt config
  if [[ -n "${PS1_ADDITIONAL_INFO:-}" ]]; then
    PS1="${PS1}""${PS1_ADDITIONAL_INFO}${PS1_COLOR_RESET}"
  fi
  # git status only if the git repo status function is installed
  if command -v __git_ps1 &>/dev/null; then
    PS1="${PS1}""${PS1_COLOR_GIT}"'$(__git_ps1 " ('"${PS1_SYMBOL_GIT_BRANCH}${PS1_COLOR_RESET}${PS1_COLOR_GIT}"'%s)")'"${PS1_COLOR_RESET}"
  fi
  # process information
  if [[ -z "${_PS1_HIDE_EXEC_TIME:-}" ]]; then
    PS1="${PS1}"" ${PS1_COLOR_EXEC_TIME}${PS1_EXEC_TIME}${PS1_COLOR_RESET}"
  fi
  # close bracket
  PS1="${PS1}""${PS1_COLOR_BOLD}${PS1_COLOR_GREY}"']'"${PS1_COLOR_RESET}"
  # newline before the user symbol
  if [[ -n "${_PS1_MULTILINE:-}" ]]; then
    PS1="${PS1}\n"
  fi
  # prompt symbol
  if [[ -n "${IS_WSL}" ]] && command -v powershell.exe &>/dev/null && is-elevated-session; then
    PS1="${PS1}${PS1_COLOR_BOLD}W*${PS1_COLOR_RESET}"
  else
    PS1="${PS1}${PS1_COLOR_BOLD}$([[ $UID == 0 ]] && echo "${PS1_SYMBOL_ROOT}" || echo "${PS1_SYMBOL_USER}")${PS1_COLOR_RESET}"
  fi
  # space & title bar
  PS1="${PROMPT_TITLE}${PS1} "
}

# generate the sudo bash prompt
function __sudo_ps1_create() {
  # Start SUDO_PS1 description
  SUDO_PS1=''
  # open bracket
  SUDO_PS1="${SUDO_PS1}""${PS1_COLOR_BOLD}${PS1_COLOR_GREY}"'['"${PS1_COLOR_RESET}"
  # show exit code
  SUDO_PS1="${SUDO_PS1}""${PS1_COLOR_EXIT_ERROR}${PS1_EXIT_STATUS}${PS1_COLOR_RESET}"
  # show number of background jobs
  SUDO_PS1="${SUDO_PS1}""${PS1_COLOR_BG_JOBS}${PS1_BG_JOBS}${PS1_COLOR_RESET}"
  # time
  if [[ -z "${_PS1_HIDE_TIME:-}" ]]; then
    SUDO_PS1="${SUDO_PS1}\$(${PS1_DATETIME})"
  fi
  # user
  SUDO_PS1="${SUDO_PS1}""${PS1_COLOR_USER}"'\u'"${PS1_COLOR_RESET}"
  # [@] based on environment
  SUDO_PS1=${SUDO_PS1}${PS1_COLOR_GREY}${PS1_SESSION_TYPE}${PS1_COLOR_RESET}
  # [host|screen session] + space
  SUDO_PS1=${SUDO_PS1}${PS1_HOST_NAME}${PS1_COLOR_RESET}' '
  # working directory
  SUDO_PS1="${SUDO_PS1}""${PS1_COLOR_WORK_DIR}${PS1_PWD_WRITABLE}"'\W'"${PS1_COLOR_RESET}"
  # close bracket
  SUDO_PS1="${SUDO_PS1}""${PS1_COLOR_BOLD}${PS1_COLOR_GREY}"']'"${PS1_COLOR_RESET}"
  # newline before the user symbol
  if [[ -n "${_PS1_MULTILINE:-}" ]]; then
    SUDO_PS1="${SUDO_PS1}\n"
  fi
  # prompt symbol
  SUDO_PS1="${SUDO_PS1}""${PS1_COLOR_BOLD}\$([[ \$UID == 0 ]] && echo ${PS1_SYMBOL_ROOT} || echo ${PS1_SYMBOL_SU})${PS1_COLOR_RESET}"
  # space & title bar
  SUDO_PS1=${PROMPT_TITLE}${SUDO_PS1}' '
}

# ---------- EXPORT PROMPTS ----------

# Execute the prompt creation function
__ps1_create
# shellcheck disable=SC2090
export PS1

# export the sudo'd bash prompt
__sudo_ps1_create
# shellcheck disable=SC2090
export SUDO_PS1

# export the interactive prompt line of the shell
PS2="$(echo -e "\xe2\x86\x92") "
export PS2

# ---------- CLEANUP ----------

# clean up these functions
unset __ps1_create \
  __sudo_ps1_create

# unset variables so they don't leak out to the bash shell
unset PS1_COLOR_NORMAL \
  PS1_COLOR_BOLD \
  PS1_COLOR_UNDERLINE \
  PS1_COLOR_RESET \
  PS1_COLOR_GREY \
  PS1_COLOR_EXIT_ERROR \
  PS1_COLOR_BG_JOBS \
  PS1_COLOR_USER \
  PS1_COLOR_HOST \
  PS1_COLOR_HOST_SCREEN \
  PS1_COLOR_WORK_DIR \
  PS1_COLOR_WORK_DIRINFO \
  PS1_COLOR_GIT \
  PS1_COLOR_EXEC_TIME \
  PS1_COLOR_TIME_AM \
  PS1_COLOR_TIME_PM \
  PS1_COLOR_LOAD \
  PS1_DATETIME \
  PS1_DAY_END \
  PS1_DAY_START \
  PS1_EXIT_STATUS \
  PS1_EXEC_TIME \
  PS1_BG_JOBS \
  PS1_LOAD_AVG \
  PS1_PWD_WRITABLE \
  PS1_SYMBOL_NO_WRITE_PWD \
  PS1_SYMBOL_GIT_BRANCH \
  PS1_SYMBOL_SSH \
  PS1_SYMBOL_LOCAL \
  PS1_SYMBOL_USER \
  PS1_SYMBOL_ROOT \
  PS1_SYMBOL_SU \
  PS1_SESSION_TYPE \
  PS1_HOST_NAME \
  PS1_ADDITIONAL_INFO \
  PROMPT_TITLE

# ---------- OTHER VARIABLES ----------

# show git status
export GIT_PS1_SHOWDIRTYSTATE=true
export GIT_PS1_SHOWSTASHSTATE=true
export GIT_PS1_SHOWUNTRACKEDFILES=true
export GIT_PS1_SHOWUPSTREAM="auto"
