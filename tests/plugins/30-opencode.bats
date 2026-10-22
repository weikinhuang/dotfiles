#!/usr/bin/env bats
# Tests for plugins/30-opencode.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
  unset OPENCODE_CONFIG_DIR OPENCODE_DB OPENCODE_PROFILE_NAME XDG_STATE_HOME
  stub_opencode_env_dump
}

stub_opencode_env_dump() {
  stub_command opencode <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${BATS_TEST_TMPDIR}/opencode-calls"
printf 'OPENCODE_CONFIG_DIR=%s\n' "${OPENCODE_CONFIG_DIR:-}"
printf 'OPENCODE_DB=%s\n' "${OPENCODE_DB:-}"
printf 'OPENCODE_PROFILE_NAME=%s\n' "${OPENCODE_PROFILE_NAME:-}"
printf 'XDG_STATE_HOME=%s\n' "${XDG_STATE_HOME:-}"
printf 'OPENAI_BASE_URL=%s\n' "${OPENAI_BASE_URL:-}"
printf 'ARGS:\n'
printf '%s\n' "$@"
EOF
}

make_profile() {
  local name="$1"
  local dir="${XDG_CONFIG_HOME}/opencode-${name}"
  mkdir -p "${dir}"
  if [[ -n "${2:-}" ]]; then
    printf '%s\n' "$2" >"${dir}/env"
  fi
  printf '%s' "${dir}"
}

@test "30-opencode: registers cached completion" {
  source "${REPO_ROOT}/plugins/30-opencode.sh"

  [ "${DOT_TEST_CACHED_COMPLETIONS[0]}" = "opencode|opencode --completions bash" ]
}

@test "30-opencode: no -u forwards args verbatim and leaves profile vars unset" {
  source "${REPO_ROOT}/plugins/30-opencode.sh"

  run opencode run hello
  assert_success
  assert_line 'OPENCODE_CONFIG_DIR='
  assert_line 'OPENCODE_DB='
  assert_line 'OPENCODE_PROFILE_NAME='
  assert_line 'XDG_STATE_HOME='
  assert_line 'run'
  assert_line 'hello'
  assert_equal "$(cat "${BATS_TEST_TMPDIR}/opencode-calls")" 'run hello'
}

@test "30-opencode: no -u sources env from default config dir" {
  mkdir -p "${XDG_CONFIG_HOME}/opencode"
  printf 'export OPENAI_BASE_URL=https://default.test\n' >"${XDG_CONFIG_HOME}/opencode/env"
  source "${REPO_ROOT}/plugins/30-opencode.sh"

  run opencode run
  assert_success
  assert_line 'OPENCODE_CONFIG_DIR='
  assert_line 'OPENAI_BASE_URL=https://default.test'
}

@test "30-opencode: no -u honours OPENCODE_CONFIG_DIR override for default env" {
  local dir="${BATS_TEST_TMPDIR}/custom-opencode"
  mkdir -p "${dir}"
  printf 'export OPENAI_BASE_URL=https://custom.test\n' >"${dir}/env"
  export OPENCODE_CONFIG_DIR="${dir}"
  source "${REPO_ROOT}/plugins/30-opencode.sh"

  run opencode run
  assert_success
  assert_line 'OPENAI_BASE_URL=https://custom.test'
}

@test "30-opencode: -u sets config dir, DB, state dir, and profile name and forwards remaining args" {
  local dir
  dir="$(make_profile work)"
  source "${REPO_ROOT}/plugins/30-opencode.sh"

  run opencode -u work run hello
  assert_success
  assert_line "OPENCODE_CONFIG_DIR=${dir}"
  assert_line "OPENCODE_DB=${dir}/opencode.db"
  assert_line 'OPENCODE_PROFILE_NAME=work'
  assert_line "XDG_STATE_HOME=${dir}/state"
  assert_line 'run'
  assert_line 'hello'
  refute_line '-u'
  refute_line 'work'
}

@test "30-opencode: -u assigns a stable service port once per profile" {
  local dir
  dir="$(make_profile work)"
  source "${REPO_ROOT}/plugins/30-opencode.sh"

  local port
  port="$(__dot_opencode_profile_port work)"
  [ "${port}" -ge 49400 ] && [ "${port}" -lt 49900 ]
  [ "$(__dot_opencode_profile_port work)" = "${port}" ]

  run opencode -u work run
  assert_success
  assert_equal "$(head -n1 "${BATS_TEST_TMPDIR}/opencode-calls")" "service set port ${port}"

  rm -f "${BATS_TEST_TMPDIR}/opencode-calls"
  printf '{"port": 49999}\n' >"${dir}/service.json"
  run opencode -u work run
  assert_success
  assert_equal "$(cat "${BATS_TEST_TMPDIR}/opencode-calls")" 'run'
}

@test "30-opencode: -u=<name> form behaves identically" {
  local dir
  dir="$(make_profile work)"
  source "${REPO_ROOT}/plugins/30-opencode.sh"

  run opencode -u=work run
  assert_success
  assert_line "OPENCODE_CONFIG_DIR=${dir}"
  assert_line 'run'
  refute_line '-u=work'
}

@test "30-opencode: sources profile env file before exec" {
  make_profile work 'export OPENAI_BASE_URL=https://example.test' >/dev/null
  source "${REPO_ROOT}/plugins/30-opencode.sh"

  run opencode -u work
  assert_success
  assert_line 'OPENAI_BASE_URL=https://example.test'
}

@test "30-opencode: subshell isolates env - caller's shell unchanged" {
  make_profile work 'export OPENAI_BASE_URL=https://example.test' >/dev/null
  source "${REPO_ROOT}/plugins/30-opencode.sh"

  unset OPENAI_BASE_URL
  opencode -u work >/dev/null
  [ -z "${OPENCODE_CONFIG_DIR:-}" ]
  [ -z "${OPENCODE_DB:-}" ]
  [ -z "${OPENCODE_PROFILE_NAME:-}" ]
  [ -z "${XDG_STATE_HOME:-}" ]
  [ -z "${OPENAI_BASE_URL:-}" ]
}

@test "30-opencode: missing profile directory is created on demand" {
  source "${REPO_ROOT}/plugins/30-opencode.sh"

  local dir="${XDG_CONFIG_HOME}/opencode-fresh"
  [ ! -d "${dir}" ]

  run opencode -u fresh run
  assert_success
  assert_line "OPENCODE_CONFIG_DIR=${dir}"
  assert_line 'run'
  [ -d "${dir}" ]
}

@test "30-opencode: -u without value fails" {
  source "${REPO_ROOT}/plugins/30-opencode.sh"

  run opencode -u
  assert_failure
  assert_output --partial 'requires a profile name'
}

@test "30-opencode: _dot_opencode completes profile names after -u" {
  make_profile work >/dev/null
  make_profile personal >/dev/null
  source "${REPO_ROOT}/plugins/30-opencode.sh"

  COMP_WORDS=(opencode -u '')
  COMP_CWORD=2
  COMPREPLY=()
  _dot_opencode

  local reply
  reply="$(printf '%s\n' "${COMPREPLY[@]}" | sort | tr '\n' ' ')"
  [ "${reply}" = "personal work " ]
}

@test "30-opencode: _dot_opencode delegates to the native completer elsewhere" {
  _fake_native_opencode() { COMPREPLY=(native-called); }
  complete -F _fake_native_opencode opencode
  source "${REPO_ROOT}/plugins/30-opencode.sh"

  COMP_WORDS=(opencode r)
  COMP_CWORD=1
  COMPREPLY=()
  _dot_opencode

  [ "${COMPREPLY[*]}" = "native-called" ]
}
