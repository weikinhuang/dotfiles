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
  internal::prompt-action-push "record_trace alpha"
  internal::prompt-action-push "record_trace beta"

  internal::prompt-action-run

  [ "${TEST_TRACE}" = 'alpha beta ' ]
}

@test "utils: hyperlink-scheme detects vscode when TERM_PROGRAM is vscode" {
  export TERM_PROGRAM=vscode
  unset GIT_ASKPASS
  __dot_hyperlink_scheme=""

  source "${REPO_ROOT}/dotenv/lib/utils.sh"

  [ "${__dot_hyperlink_scheme}" = "vscode" ]
}

@test "utils: hyperlink-scheme detects vscode-insiders via GIT_ASKPASS" {
  export TERM_PROGRAM=vscode
  export GIT_ASKPASS="/home/user/.vscode-server-insiders/bin/hash/git-askpass.sh"
  __dot_hyperlink_scheme=""

  source "${REPO_ROOT}/dotenv/lib/utils.sh"

  [ "${__dot_hyperlink_scheme}" = "vscode-insiders" ]
}

@test "utils: hyperlink-scheme detects cursor via GIT_ASKPASS" {
  export TERM_PROGRAM=vscode
  export GIT_ASKPASS="/home/user/.cursor-server/bin/hash/git-askpass.sh"
  __dot_hyperlink_scheme=""

  source "${REPO_ROOT}/dotenv/lib/utils.sh"

  [ "${__dot_hyperlink_scheme}" = "cursor" ]
}

@test "utils: hyperlink-scheme honors DOT_HYPERLINK_SCHEME override" {
  export DOT_HYPERLINK_SCHEME="custom-editor"
  unset TERM_PROGRAM
  __dot_hyperlink_scheme=""

  source "${REPO_ROOT}/dotenv/lib/utils.sh"

  [ "${__dot_hyperlink_scheme}" = "custom-editor" ]
}

@test "utils: hyperlink-scheme is empty outside vscode terminals" {
  unset TERM_PROGRAM
  unset DOT_HYPERLINK_SCHEME
  __dot_hyperlink_scheme=""

  source "${REPO_ROOT}/dotenv/lib/utils.sh"

  [ -z "${__dot_hyperlink_scheme}" ]
}

@test "utils: vscode-remote-prefix builds WSL authority when scheme and distro are set" {
  export TERM_PROGRAM=vscode
  export DOT___IS_WSL=1
  export WSL_DISTRO_NAME="Ubuntu"
  unset GIT_ASKPASS
  __dot_hyperlink_scheme=""
  __dot_hyperlink_vscode_remote_prefix=""

  source "${REPO_ROOT}/dotenv/lib/utils.sh"

  [ "${__dot_hyperlink_vscode_remote_prefix}" = "vscode://vscode-remote/wsl+Ubuntu" ]
}

@test "utils: vscode-remote-prefix builds SSH authority when scheme and host are set" {
  export TERM_PROGRAM=vscode
  export DOT___IS_SSH=1
  export DOT_HYPERLINK_SSH_HOST="myserver"
  unset GIT_ASKPASS
  __dot_hyperlink_scheme=""
  __dot_hyperlink_vscode_remote_prefix=""

  source "${REPO_ROOT}/dotenv/lib/utils.sh"

  [ "${__dot_hyperlink_vscode_remote_prefix}" = "vscode://vscode-remote/ssh-remote+myserver" ]
}

@test "utils: vscode-remote-prefix is empty without a scheme" {
  unset TERM_PROGRAM
  unset DOT_HYPERLINK_SCHEME
  export DOT___IS_WSL=1
  export WSL_DISTRO_NAME="Ubuntu"
  __dot_hyperlink_scheme=""
  __dot_hyperlink_vscode_remote_prefix=""

  source "${REPO_ROOT}/dotenv/lib/utils.sh"

  [ -z "${__dot_hyperlink_vscode_remote_prefix}" ]
}

@test "utils: vscode-remote-prefix is empty for SSH without DOT_HYPERLINK_SSH_HOST" {
  export TERM_PROGRAM=vscode
  export DOT___IS_SSH=1
  unset DOT_HYPERLINK_SSH_HOST
  unset GIT_ASKPASS
  __dot_hyperlink_scheme=""
  __dot_hyperlink_vscode_remote_prefix=""

  source "${REPO_ROOT}/dotenv/lib/utils.sh"

  [ -z "${__dot_hyperlink_vscode_remote_prefix}" ]
}

@test "utils: vscode-remote-prefix uses cursor scheme for Cursor terminal on WSL" {
  export TERM_PROGRAM=vscode
  export GIT_ASKPASS="/home/user/.cursor-server/bin/hash/git-askpass.sh"
  export DOT___IS_WSL=1
  export WSL_DISTRO_NAME="Debian"
  __dot_hyperlink_scheme=""
  __dot_hyperlink_vscode_remote_prefix=""

  source "${REPO_ROOT}/dotenv/lib/utils.sh"

  [ "${__dot_hyperlink_vscode_remote_prefix}" = "cursor://vscode-remote/wsl+Debian" ]
}

@test "utils: find-editor prefers VS Code in a remote server path" {
  local vscode_bin="${BATS_TEST_TMPDIR}/.vscode-server/bin/hash/bin"
  mkdir -p "${vscode_bin}"
  # shellcheck disable=SC2030
  export TERM_PROGRAM=vscode
  # shellcheck disable=SC2030
  export GIT_ASKPASS="${BATS_TEST_TMPDIR}/.vscode-server/bin/hash/git-askpass.sh"
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

@test "utils: find-editor prefers Cursor in a remote server path" {
  local cursor_bin="${BATS_TEST_TMPDIR}/.cursor-server/bin/hash/bin"
  mkdir -p "${cursor_bin}"
  # shellcheck disable=SC2031
  export TERM_PROGRAM=vscode
  # shellcheck disable=SC2031
  export GIT_ASKPASS="${BATS_TEST_TMPDIR}/.cursor-server/bin/hash/git-askpass.sh"
  PATH="${cursor_bin}:/usr/bin:/bin"
  __dot_find_editor_result=

  cat >"${cursor_bin}/cursor" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "${cursor_bin}/cursor"

  run internal::find-editor
  assert_success
  assert_output "cursor --wait"
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

@test "utils: find-editor skips autodetect when DOT_DISABLE_EDITOR_AUTODETECT is set" {
  export DOT_DISABLE_EDITOR_AUTODETECT=1
  unset TERM_PROGRAM
  unset DOT___IS_SSH
  __dot_find_editor_result=
  use_mock_bin_path
  stub_passthrough_command "code"
  stub_passthrough_command "nvim"

  run internal::find-editor
  assert_success
  assert_output "nvim"
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

@test "utils: cache-dir-prepare is a no-op when the parent directory exists" {
  local base="${BATS_TEST_TMPDIR}/cache-parent"
  mkdir -p "${base}"
  local cache_file="${base}/tool.init.bash"

  run internal::cache-dir-prepare "${cache_file}"
  assert_success
  [ -d "${base}" ]
}

@test "utils: cache-dir-prepare creates missing parent directories" {
  local base="${BATS_TEST_TMPDIR}/nested"
  local cache_file="${base}/deep/tool.init.bash"

  run internal::cache-dir-prepare "${cache_file}"
  assert_success
  [ -d "${base}/deep" ]
}

@test "utils: cache-write-atomic removes temporary files on generator failure" {
  local cache_file="${DOTFILES__CONFIG_DIR}/cache/failing.init.bash"

  run internal::cache-write-atomic "${cache_file}" "false"
  assert_failure

  [ ! -e "${cache_file}" ]
  [ "$(find "${DOTFILES__CONFIG_DIR}/cache" -maxdepth 1 -name 'failing.init.bash.*' | wc -l)" -eq 0 ]
}

@test "utils: cache-write-atomic writes the generator output atomically" {
  local cache_file="${DOTFILES__CONFIG_DIR}/cache/ok.init.bash"

  run internal::cache-write-atomic "${cache_file}" "printf '%s' hello-world"
  assert_success

  [ "$(cat "${cache_file}")" = "hello-world" ]
  [ "$(find "${DOTFILES__CONFIG_DIR}/cache" -maxdepth 1 -name 'ok.init.bash.*' | wc -l)" -eq 0 ]
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
