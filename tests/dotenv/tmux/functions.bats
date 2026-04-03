#!/usr/bin/env bats
# Tests for dotenv/tmux/functions.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
  setup_plugin_test_env
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
}

@test "tmux/functions: defines internal::tmux-reload-env" {
  source "${REPO_ROOT}/dotenv/tmux/functions.sh"
  internal::tmux-reload-env
  [ "${TMUX_PLUGIN_ENV}" = "1" ]
}

@test "tmux/functions: defines internal::tmux-sync-powerline-pwd" {
  local project_dir="${BATS_TEST_TMPDIR}/project"
  mkdir -p "${project_dir}"
  cd "${project_dir}"

  source "${REPO_ROOT}/dotenv/tmux/functions.sh"
  internal::tmux-sync-powerline-pwd

  grep -F "setenv -g TMUX_PWD_3 ${project_dir}" "${TMUX_LOG}"
  grep -F "refresh -S" "${TMUX_LOG}"
}

@test "tmux/functions: defines internal::tmux-sync-powerline-pwd with redundant sync prevention" {
  local project_dir="${BATS_TEST_TMPDIR}/project"
  mkdir -p "${project_dir}"
  cd "${project_dir}"

  source "${REPO_ROOT}/dotenv/tmux/functions.sh"
  internal::tmux-sync-powerline-pwd

  : >"${TMUX_LOG}"

  internal::tmux-sync-powerline-pwd

  [ ! -s "${TMUX_LOG}" ]
}

@test "tmux/functions: defines internal::tmux-sync-powerline-pwd with re-sync after cwd change" {
  local project_dir="${BATS_TEST_TMPDIR}/project"
  local other_dir="${BATS_TEST_TMPDIR}/other"
  mkdir -p "${project_dir}" "${other_dir}"
  cd "${project_dir}"

  source "${REPO_ROOT}/dotenv/tmux/functions.sh"
  internal::tmux-sync-powerline-pwd

  : >"${TMUX_LOG}"

  cd "${other_dir}"
  internal::tmux-sync-powerline-pwd

  grep -F "setenv -g TMUX_PWD_3 ${other_dir}" "${TMUX_LOG}"
  grep -F "refresh -S" "${TMUX_LOG}"
}
