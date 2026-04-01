#!/usr/bin/env bats
# Tests for dotenv/lib/utils.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
  setup_test_bin
  setup_isolated_home

  export DOTFILES__CONFIG_DIR="${XDG_CONFIG_HOME}/dotfiles"
  mkdir -p "${DOTFILES__CONFIG_DIR}/cache/completions"

  source "${REPO_ROOT}/dotenv/lib/utils.sh"
}

@test "utils: push-prompt-command trims whitespace and avoids duplicate commands" {
  PROMPT_COMMAND=' history -a ; internal::prompt-action-run; '

  internal::prompt-command-push "internal::prompt-action-run"

  [ "${PROMPT_COMMAND}" = 'history -a;internal::prompt-action-run;' ]
}

@test "utils: run-prompt-command executes queued commands in order" {
  TEST_TRACE=
  record_trace() {
    TEST_TRACE="${TEST_TRACE}${1} "
  }

  internal::prompt-action-push "record_trace alpha"
  internal::prompt-action-push "record_trace beta"

  internal::prompt-action-run

  [ "${TEST_TRACE}" = 'alpha beta ' ]
}

@test "utils: find-editor prefers VS Code in a remote server path" {
  local vscode_bin="${BATS_TEST_TMPDIR}/.vscode-server/bin/hash/bin"
  mkdir -p "${vscode_bin}"
  PATH="${vscode_bin}:/usr/bin:/bin"
  __dot_find_editor_result=

  cat >"${vscode_bin}/code" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "${vscode_bin}/code"

  run internal::find-editor
  assert_success
  assert_output "code --wait"
}

@test "utils: find-editor prefers npp inside WSL when remote VS Code is unavailable" {
  export DOT___IS_WSL=1
  __dot_find_editor_result=
  use_mock_bin_path
  stub_passthrough_command "npp"

  run internal::find-editor
  assert_success
  assert_output "npp"
}

@test "utils: cached-eval writes and sources a missing cache file" {
  internal::cached-eval demo-tool "printf 'export TEST_CACHED_EVAL=ready\\n'"

  [ "${TEST_CACHED_EVAL}" = 'ready' ]
  [ -f "${DOTFILES__CONFIG_DIR}/cache/demo-tool.init.bash" ]
}

@test "utils: cached-eval sources an existing cache and refreshes when the tool is newer" {
  local cache_file="${DOTFILES__CONFIG_DIR}/cache/demo-tool.init.bash"
  printf 'export TEST_CACHED_EVAL=stale\n' >"${cache_file}"

  stub_fixed_output_command "demo-tool" ""
  touch -d '@1000000000' "${cache_file}"
  touch -d '@1000000001' "${MOCK_BIN}/demo-tool"

  TEST_REFRESH_FILE=
  TEST_REFRESH_CMD=
  internal::cache-refresh-async() {
    TEST_REFRESH_FILE="$1"
    TEST_REFRESH_CMD="$2"
  }

  internal::cached-eval demo-tool "printf 'export TEST_CACHED_EVAL=fresh\\n'"

  [ "${TEST_CACHED_EVAL}" = 'stale' ]
  [ "${TEST_REFRESH_FILE}" = "${cache_file}" ]
  [ "${TEST_REFRESH_CMD}" = "printf 'export TEST_CACHED_EVAL=fresh\\n'" ]
}

@test "utils: cached-completion writes and sources a missing completion cache" {
  internal::cached-completion demo-tool "printf 'complete -W \"alpha beta\" demo-tool\\n'"

  local completion_def
  completion_def="$(complete -p demo-tool)"

  [[ "${completion_def}" == *'alpha beta'* ]]
  [ -f "${DOTFILES__CONFIG_DIR}/cache/completions/demo-tool.bash" ]
}

@test "utils: cache-write-atomic removes temporary files on generator failure" {
  local cache_file="${DOTFILES__CONFIG_DIR}/cache/failing.init.bash"

  run internal::cache-write-atomic "${cache_file}" "false"
  assert_failure

  [ ! -e "${cache_file}" ]
  [ "$(find "${DOTFILES__CONFIG_DIR}/cache" -maxdepth 1 -name 'failing.init.bash.tmp.*' | wc -l)" -eq 0 ]
}

@test "utils: cache-write-atomic fails quietly when the cache directory cannot be created" {
  local blocked_root="${BATS_TEST_TMPDIR}/blocked"
  local cache_file="${blocked_root}/cache/demo-tool.init.bash"

  printf 'not a directory\n' >"${blocked_root}"

  run internal::cache-write-atomic "${cache_file}" "printf 'export TEST_CACHED_EVAL=ready\\n'"

  assert_failure
  assert_output ""
  [ ! -e "${cache_file}" ]
}
