#!/usr/bin/env bats
# Tests for dotenv/prompt.sh (prompt orchestrator).
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_test_bin
  setup_isolated_home

  export TERM=xterm-256color
  export DOTFILES__CONFIG_DIR="${XDG_CONFIG_HOME}/dotfiles"
  mkdir -p "${DOTFILES__CONFIG_DIR}"

  PROMPT_COMMAND=
  __dot_prompt_actions=()
  chpwd_functions=()
  preexec_functions=()

  export DOTFILES__ROOT="${BATS_TEST_TMPDIR}/root"
  mkdir -p "${DOTFILES__ROOT}"
  ln -snf "${REPO_ROOT}" "${DOTFILES__ROOT}/.dotfiles"

  source "${REPO_ROOT}/dotenv/lib/utils.sh"
  source "${REPO_ROOT}/dotenv/lib/prompt.sh"

  internal::ps1-proc-use() {
    echo -n "0.42"
  }

  is-elevated-session() {
    return 1
  }
}

@test "prompt: DOT_DISABLE_PS1 skips prompt setup and clears the flag" {
  export DOT_DISABLE_PS1=1
  PS1="before"

  source "${REPO_ROOT}/dotenv/prompt.sh"

  [ "${PS1}" = "before" ]
  [ -z "${DOT_DISABLE_PS1+x}" ]
}

@test "prompt: sourcing exports prompt variables and registers prompt hooks" {
  source "${REPO_ROOT}/dotenv/prompt.sh"

  [[ "${PS1}" == *'['*']'* ]]
  [[ "${SUDO_PS1}" == *'['*']'* ]]
  [ "${PS2}" = $'\342\206\222 ' ]
  [[ -n "${PS4}" ]]
  [[ " ${preexec_functions[*]} " == *' internal::ps1-exec-timer-start '* ]]
  [[ " ${chpwd_functions[*]} " == *' internal::ps1-git-cache-invalidate '* ]]
  [[ " ${__dot_prompt_actions[*]} " == *' internal::ps1-exec-timer-stop '* ]]
  [[ " ${__dot_prompt_actions[*]} " == *' internal::ps1-newline-check '* ]]
  [[ " ${__dot_prompt_actions[*]} " == *' internal::ps1-git-update '* ]]
  [[ " ${__dot_prompt_actions[*]} " == *' internal::ps1-time-refresh '* ]]
  [[ " ${__dot_prompt_actions[*]} " == *' internal::ps1-loadavg-refresh '* ]]
  [ "${GIT_PS1_SHOWDIRTYSTATE}" = "true" ]
}

@test "prompt: sourcing twice does not duplicate hook registrations" {
  count_matches() {
    local target="$1"
    shift
    local count=0 item
    for item in "$@"; do
      [[ "${item}" == "${target}" ]] && ((count++))
    done
    echo "${count}"
  }

  source "${REPO_ROOT}/dotenv/prompt.sh"
  source "${REPO_ROOT}/dotenv/prompt.sh"

  [ "$(count_matches internal::ps1-exec-timer-start "${preexec_functions[@]}")" -eq 1 ]
  [ "$(count_matches internal::ps1-git-preexec-mark-dirty "${preexec_functions[@]}")" -eq 1 ]
  [ "$(count_matches internal::ps1-dir-info-refresh "${chpwd_functions[@]}")" -eq 1 ]
  [ "$(count_matches internal::ps1-git-cache-invalidate "${chpwd_functions[@]}")" -eq 1 ]
  [ "$(count_matches internal::ps1-exec-timer-stop "${__dot_prompt_actions[@]}")" -eq 1 ]
  [ "$(count_matches internal::ps1-newline-check "${__dot_prompt_actions[@]}")" -eq 1 ]
  [ "$(count_matches internal::ps1-git-update "${__dot_prompt_actions[@]}")" -eq 1 ]
  [ "$(count_matches internal::ps1-time-refresh "${__dot_prompt_actions[@]}")" -eq 1 ]
  [ "$(count_matches internal::ps1-loadavg-refresh "${__dot_prompt_actions[@]}")" -eq 1 ]
}

@test "prompt: honors DOT_PS1_TITLE override" {
  export DOT_PS1_TITLE='custom-title '

  source "${REPO_ROOT}/dotenv/prompt.sh"

  [[ "${PS1}" == custom-title\ * ]]
  [[ "${SUDO_PS1}" == custom-title\ * ]]
}

@test "prompt: honors PROMPT_TITLE as fallback" {
  export PROMPT_TITLE='custom-title '

  source "${REPO_ROOT}/dotenv/prompt.sh"

  [[ "${PS1}" == custom-title\ * ]]
  [[ "${SUDO_PS1}" == custom-title\ * ]]
}

@test "prompt: tmux-256color sessions show tmux session info in the host segment" {
  export TERM=tmux-256color
  export TMUX=/tmp/tmux.sock
  export TMUX_PANE=%3
  stub_command tmux <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "display-message" ]] && [[ "${2:-}" == "-p" ]] && [[ "${3:-}" == "#S" ]]; then
  printf 'work\n'
fi
EOF

  source "${REPO_ROOT}/dotenv/prompt.sh"

  [[ "${PS1}" == *'work[%3]'* ]]
  [[ "${SUDO_PS1}" == *'work[%3]'* ]]
}

@test "prompt: honors DOT_PS1_SYMBOL_USER override" {
  export DOT_PS1_SYMBOL_USER='USR'
  export DOT_PS1_SYMBOL_ROOT='USR'

  source "${REPO_ROOT}/dotenv/prompt.sh"

  [[ "${PS1}" == *'USR'* ]]
}

@test "prompt: honors DOT_PS1_SYMBOL_GIT override" {
  local repo="${BATS_TEST_TMPDIR}/repo"
  mkdir -p "${repo}/.git/refs"
  : >"${repo}/.git/HEAD"
  : >"${repo}/.git/index"
  : >"${repo}/.git/refs/stash"
  cd "${repo}"

  __git_ps1() {
    printf "$1" "main"
  }

  export DOT_PS1_SYMBOL_GIT='GIT '
  export DOT_GIT_PROMPT_INVALIDATE_ON_GIT=0

  source "${REPO_ROOT}/dotenv/prompt.sh"
  internal::ps1-git-update

  # shellcheck disable=SC2154
  [[ "${__dot_ps1_git_segment}" == *'GIT '* ]]
}

@test "prompt: removing segments from DOT_PS1_SEGMENTS hides them" {
  DOT_PS1_SEGMENTS=(exit_status user workdir)

  source "${REPO_ROOT}/dotenv/prompt.sh"
  internal::prompt-action-run

  [[ "${PS1@P}" != *'0.42'* ]]
}

@test "prompt: time and loadavg segments are cached instead of embedding shell snippets" {
  source "${REPO_ROOT}/dotenv/prompt.sh"

  [[ "${PS1}" != *'internal::ps1-proc-use'* ]]
  [[ "${PS1}" != *'printf -v time'* ]]
  [[ "${PS1}" == *'${__dot_ps1_time_segment}'* ]]
  [[ "${PS1}" == *'${__dot_ps1_loadavg_segment}'* ]]
}

@test "prompt: WSL elevated sessions use the Windows privileged prompt symbol" {
  export DOT___IS_WSL=1
  stub_passthrough_command "powershell.exe"

  is-elevated-session() {
    return 0
  }

  source "${REPO_ROOT}/dotenv/prompt.sh"

  [[ "${PS1}" == *'W*'* ]]
  [[ "${SUDO_PS1}" == *'W*'* ]]
}

@test "prompt: PS4 has a useful default" {
  source "${REPO_ROOT}/dotenv/prompt.sh"

  [[ "${PS4}" == *'BASH_SOURCE'* ]]
  [[ "${PS4}" == *'LINENO'* ]]
  # trailing space must be unconditional so commands without FUNCNAME are separated
  [[ "${PS4}" == *' ' ]]
}

@test "prompt: DOT_PS4 override is honored" {
  export DOT_PS4='+ custom: '

  source "${REPO_ROOT}/dotenv/prompt.sh"

  [ "${PS4}" = '+ custom: ' ]
}

@test "prompt: internal::ps1-rebuild regenerates prompts" {
  source "${REPO_ROOT}/dotenv/prompt.sh"

  internal::ps1-rebuild
  [[ "${PS1}" == *'['*']'* ]]
}

@test "prompt: custom ps1_render function is picked up" {
  ps1_render_custom() {
    echo " CUSTOM"
  }

  DOT_PS1_SEGMENTS=(exit_status custom)

  source "${REPO_ROOT}/dotenv/prompt.sh"

  [[ "${PS1}" == *'CUSTOM'* ]]
}

@test "prompt: DOT_PS1_COLOR_* vars are cleaned up after sourcing" {
  export DOT_PS1_COLOR_USER='\[\e[38;5;100m\]'

  source "${REPO_ROOT}/dotenv/prompt.sh"

  [ -z "${DOT_PS1_COLOR_USER+x}" ]
}

@test "prompt: DOT_PS1_SEGMENTS persists after sourcing for rebuild" {
  source "${REPO_ROOT}/dotenv/prompt.sh"

  declare -p DOT_PS1_SEGMENTS &>/dev/null
}

@test "prompt: empty segment list produces valid bracket pair" {
  DOT_PS1_SEGMENTS=()

  source "${REPO_ROOT}/dotenv/prompt.sh"

  [[ "${PS1}" == *'['*']'* ]]
}

@test "prompt: newline-check sets newline when COLUMNS is below threshold" {
  source "${REPO_ROOT}/dotenv/prompt.sh"

  COLUMNS=80
  __dot_ps1_newline_threshold=120
  internal::ps1-newline-check
  [ "${__dot_ps1_newline}" = $'\n' ]

  COLUMNS=200
  internal::ps1-newline-check
  [ -z "${__dot_ps1_newline}" ]
}

@test "prompt: internal::ps1-rebuild picks up new DOT_PS1_TITLE" {
  source "${REPO_ROOT}/dotenv/prompt.sh"

  DOT_PS1_TITLE='new-title '
  internal::ps1-rebuild

  [[ "${PS1}" == new-title\ * ]]
  [[ "${SUDO_PS1}" == new-title\ * ]]
}

@test "prompt: dir-info-refresh skips when dirinfo segment is removed" {
  DOT_PS1_SEGMENTS=(exit_status user workdir)

  source "${REPO_ROOT}/dotenv/prompt.sh"

  __dot_ps1_dirinfo="stale"
  internal::ps1-dir-info-refresh
  [ "${__dot_ps1_dirinfo}" = "stale" ]
}

@test "prompt: workdir segment includes OSC 8 link when hyperlinks are enabled" {
  DOT_PS1_SEGMENTS=(workdir)
  __dot_hyperlink_scheme=""

  source "${REPO_ROOT}/dotenv/prompt.sh"

  [[ "${PS1}" == *'${__dot_ps1_workdir_osc8_start}'* ]]
  [[ -n "${__dot_ps1_workdir_osc8_start}" ]]
  [[ "${__dot_ps1_workdir_osc8_start}" == *']8;;file://'* ]]
}

@test "prompt: workdir segment omits OSC 8 link when DOT_DISABLE_HYPERLINKS is set" {
  DOT_PS1_SEGMENTS=(workdir)
  export DOT_DISABLE_HYPERLINKS=1
  __dot_hyperlink_scheme=""

  source "${REPO_ROOT}/dotenv/prompt.sh"

  [[ -z "${__dot_ps1_workdir_osc8_start}" ]]
}

@test "prompt: workdir segment omits OSC 8 link over SSH without scheme" {
  DOT_PS1_SEGMENTS=(workdir)
  export DOT___IS_SSH=1
  __dot_hyperlink_scheme=""

  source "${REPO_ROOT}/dotenv/prompt.sh"

  [[ -z "${__dot_ps1_workdir_osc8_start}" ]]
}

@test "prompt: workdir segment includes OSC 8 link over SSH with scheme" {
  DOT_PS1_SEGMENTS=(workdir)
  export DOT___IS_SSH=1
  __dot_hyperlink_scheme="vscode"

  source "${REPO_ROOT}/dotenv/prompt.sh"

  [[ -n "${__dot_ps1_workdir_osc8_start}" ]]
  [[ "${__dot_ps1_workdir_osc8_start}" == *']8;;file://'* ]]
}

@test "prompt: workdir uses wsl.localhost prefix on WSL" {
  DOT_PS1_SEGMENTS=(workdir)
  export DOT___IS_WSL=1
  export WSL_DISTRO_NAME="Ubuntu"
  __dot_hyperlink_scheme=""

  source "${REPO_ROOT}/dotenv/prompt.sh"

  [[ "${__dot_ps1_workdir_osc8_start}" == *'wsl.localhost/Ubuntu'* ]]
}

@test "prompt: workdir uses native Windows URL for WSL /mnt/ paths" {
  DOT_PS1_SEGMENTS=(workdir)
  export DOT___IS_WSL=1
  export WSL_DISTRO_NAME="Ubuntu"
  __dot_hyperlink_scheme=""

  source "${REPO_ROOT}/dotenv/prompt.sh"

  PWD=/mnt/d/projects/test
  internal::ps1-workdir-osc8-update

  [[ "${__dot_ps1_workdir_osc8_start}" == *'file:///D:/projects/test'* ]]
  [[ "${__dot_ps1_workdir_osc8_start}" != *'wsl.localhost'* ]]
}
