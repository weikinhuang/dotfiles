#!/usr/bin/env bats
# Tests for plugins/30-codex.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
  stub_codex_env_dump
}

stub_codex_env_dump() {
  stub_command codex <<'EOF'
#!/usr/bin/env bash
printf 'CODEX_HOME=%s\n' "${CODEX_HOME:-}"
printf 'OPENAI_BASE_URL=%s\n' "${OPENAI_BASE_URL:-}"
printf 'ARGS:\n'
printf '%s\n' "$@"
EOF
}

make_profile() {
  local name="$1"
  local dir="${XDG_CONFIG_HOME}/codex-${name}"
  mkdir -p "${dir}"
  if [[ -n "${2:-}" ]]; then
    printf '%s\n' "$2" >"${dir}/env"
  fi
  printf '%s' "${dir}"
}

@test "30-codex: registers cached completion" {
  source "${REPO_ROOT}/plugins/30-codex.sh"

  [ "${DOT_TEST_CACHED_COMPLETIONS[0]}" = "codex|codex completion" ]
}

@test "30-codex: no -u forwards args verbatim and leaves CODEX_HOME unset" {
  source "${REPO_ROOT}/plugins/30-codex.sh"

  run codex exec hello
  assert_success
  assert_line 'CODEX_HOME='
  assert_line 'exec'
  assert_line 'hello'
}

@test "30-codex: no -u sources env from default config dir" {
  mkdir -p "${HOME}/.codex"
  printf 'export OPENAI_BASE_URL=https://default.test\n' >"${HOME}/.codex/env"
  source "${REPO_ROOT}/plugins/30-codex.sh"

  run codex exec
  assert_success
  assert_line 'CODEX_HOME='
  assert_line 'OPENAI_BASE_URL=https://default.test'
}

@test "30-codex: no -u honours CODEX_HOME override for default env" {
  local dir="${BATS_TEST_TMPDIR}/custom-codex"
  mkdir -p "${dir}"
  printf 'export OPENAI_BASE_URL=https://custom.test\n' >"${dir}/env"
  export CODEX_HOME="${dir}"
  source "${REPO_ROOT}/plugins/30-codex.sh"

  run codex exec
  assert_success
  assert_line 'OPENAI_BASE_URL=https://custom.test'
}

@test "30-codex: -u sets CODEX_HOME and forwards remaining args" {
  local dir
  dir="$(make_profile aws)"
  source "${REPO_ROOT}/plugins/30-codex.sh"

  run codex -u aws exec hello
  assert_success
  assert_line "CODEX_HOME=${dir}"
  assert_line 'exec'
  assert_line 'hello'
  refute_line '-u'
  refute_line 'aws'
}

@test "30-codex: -u=<name> form behaves identically" {
  local dir
  dir="$(make_profile aws)"
  source "${REPO_ROOT}/plugins/30-codex.sh"

  run codex -u=aws exec
  assert_success
  assert_line "CODEX_HOME=${dir}"
  assert_line 'exec'
  refute_line '-u=aws'
}

@test "30-codex: sources profile env file before exec" {
  make_profile aws 'export OPENAI_BASE_URL=https://example.test' >/dev/null
  source "${REPO_ROOT}/plugins/30-codex.sh"

  run codex -u aws
  assert_success
  assert_line 'OPENAI_BASE_URL=https://example.test'
}

@test "30-codex: subshell isolates env - caller's shell unchanged" {
  make_profile aws 'export OPENAI_BASE_URL=https://example.test' >/dev/null
  source "${REPO_ROOT}/plugins/30-codex.sh"

  unset CODEX_HOME OPENAI_BASE_URL
  codex -u aws >/dev/null
  [ -z "${CODEX_HOME:-}" ]
  [ -z "${OPENAI_BASE_URL:-}" ]
}

@test "30-codex: missing profile directory is created on demand" {
  source "${REPO_ROOT}/plugins/30-codex.sh"

  local dir="${XDG_CONFIG_HOME}/codex-fresh"
  [ ! -d "${dir}" ]

  run codex -u fresh exec
  assert_success
  assert_line "CODEX_HOME=${dir}"
  assert_line 'exec'
  [ -d "${dir}" ]
}

@test "30-codex: -u without value fails" {
  source "${REPO_ROOT}/plugins/30-codex.sh"

  run codex -u
  assert_failure
  assert_output --partial 'requires a profile name'
}

@test "30-codex: _dot_codex completes profile names after -u" {
  make_profile aws >/dev/null
  make_profile gcp >/dev/null
  source "${REPO_ROOT}/plugins/30-codex.sh"

  COMP_WORDS=(codex -u '')
  COMP_CWORD=2
  COMPREPLY=()
  _dot_codex

  local reply
  reply="$(printf '%s\n' "${COMPREPLY[@]}" | sort | tr '\n' ' ')"
  [ "${reply}" = "aws gcp " ]
}
