#!/usr/bin/env bats
# Tests for dotenv/tmux/extra.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
  setup_plugin_test_env
  source "${REPO_ROOT}/dotenv/tmux/functions.sh"
  export TERM=tmux-256color
  export TMUX=/tmp/tmux.sock
  export TMUX_PANE=%3
  export TMUX_LOG="${BATS_TEST_TMPDIR}/tmux.log"
  stub_command tmux <<'EOF'
#!/usr/bin/env bash
printf '%q ' "$@" >>"${TMUX_LOG}"
printf '\n' >>"${TMUX_LOG}"
if [[ "${1:-}" == "show-env" ]] && [[ "${2:-}" == "-s" ]]; then
  printf 'export TMUX_PLUGIN_ENV=1\n'
fi
EOF

  # Populated when sourcing extra.sh; assign here so shellcheck sees assignment in this file (SC2154).
  # shellcheck disable=SC2034
  __dot_prompt_actions=()
}

@test "tmux/extra: registers prompt actions for tmux integration" {
  source "${REPO_ROOT}/dotenv/tmux/extra.sh"

  [ "${__dot_prompt_actions[0]}" = "internal::tmux-sync-powerline-pwd" ]
  [ "${__dot_prompt_actions[1]}" = "internal::tmux-reload-env" ]
}

@test "tmux/extra: immediately syncs pane cwd on load" {
  local project_dir="${BATS_TEST_TMPDIR}/project"
  mkdir -p "${project_dir}"
  cd "${project_dir}"

  source "${REPO_ROOT}/dotenv/tmux/extra.sh"

  grep -F "setenv -g TMUX_PWD_3 ${project_dir}" "${TMUX_LOG}"
  grep -F "refresh -S" "${TMUX_LOG}"
}

@test "tmux/extra: skips redundant syncs when the pane cwd is unchanged" {
  local project_dir="${BATS_TEST_TMPDIR}/project"
  mkdir -p "${project_dir}"
  cd "${project_dir}"

  source "${REPO_ROOT}/dotenv/tmux/extra.sh"
  : >"${TMUX_LOG}"

  internal::tmux-sync-powerline-pwd

  [ ! -s "${TMUX_LOG}" ]
}

@test "tmux/extra: re-syncs after the pane cwd changes" {
  local project_dir="${BATS_TEST_TMPDIR}/project"
  local other_dir="${BATS_TEST_TMPDIR}/other"
  mkdir -p "${project_dir}" "${other_dir}"
  cd "${project_dir}"

  source "${REPO_ROOT}/dotenv/tmux/extra.sh"
  : >"${TMUX_LOG}"

  cd "${other_dir}"
  internal::tmux-sync-powerline-pwd

  grep -F "setenv -g TMUX_PWD_3 ${other_dir}" "${TMUX_LOG}"
  grep -F "refresh -S" "${TMUX_LOG}"
}
