#!/usr/bin/env bats
# Tests for plugins/30-copilot.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
  unset COPILOT_HOME COPILOT_PROFILE_NAME COPILOT_SKILLS_DIRS
  stub_copilot_env_dump
}

stub_copilot_env_dump() {
  stub_command copilot <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${BATS_TEST_TMPDIR}/copilot-calls"
printf 'COPILOT_HOME=%s\n' "${COPILOT_HOME:-}"
printf 'COPILOT_PROFILE_NAME=%s\n' "${COPILOT_PROFILE_NAME:-}"
printf 'COPILOT_SKILLS_DIRS=%s\n' "${COPILOT_SKILLS_DIRS:-}"
printf 'GH_HOST=%s\n' "${GH_HOST:-}"
printf 'ARGS:\n'
printf '%s\n' "$@"
EOF
}

make_profile() {
  local name="$1"
  local dir="${XDG_CONFIG_HOME}/copilot-${name}"
  mkdir -p "${dir}"
  if [[ -n "${2:-}" ]]; then
    printf '%s\n' "$2" >"${dir}/env"
  fi
  printf '%s' "${dir}"
}

@test "30-copilot: registers cached completion" {
  source "${REPO_ROOT}/plugins/30-copilot.sh"

  [ "${DOT_TEST_CACHED_COMPLETIONS[0]}" = "copilot|copilot completion bash" ]
}

@test "30-copilot: no -u forwards args after the telemetry flag and leaves profile vars unset" {
  source "${REPO_ROOT}/plugins/30-copilot.sh"

  run copilot -p hello
  assert_success
  assert_line 'COPILOT_HOME='
  assert_line 'COPILOT_PROFILE_NAME='
  assert_line 'COPILOT_SKILLS_DIRS='
  assert_equal "$(cat "${BATS_TEST_TMPDIR}/copilot-calls")" '--disable-client-telemetry -p hello'
}

@test "30-copilot: no -u sources env from ~/.copilot" {
  mkdir -p "${HOME}/.copilot"
  printf 'export GH_HOST=default.test\n' >"${HOME}/.copilot/env"
  source "${REPO_ROOT}/plugins/30-copilot.sh"

  run copilot
  assert_success
  assert_line 'COPILOT_HOME='
  assert_line 'GH_HOST=default.test'
}

@test "30-copilot: no -u honours COPILOT_HOME override for env and rules" {
  local dir="${BATS_TEST_TMPDIR}/custom-copilot"
  mkdir -p "${dir}"
  printf 'export GH_HOST=custom.test\n' >"${dir}/env"
  printf 'deny read(.env)\n' >"${dir}/tool-permissions"
  export COPILOT_HOME="${dir}"
  source "${REPO_ROOT}/plugins/30-copilot.sh"

  run copilot
  assert_success
  assert_line 'GH_HOST=custom.test'
  assert_line '--deny-tool=read(.env)'
}

@test "30-copilot: -u sets COPILOT_HOME and profile name and forwards remaining args" {
  local dir
  dir="$(make_profile work)"
  source "${REPO_ROOT}/plugins/30-copilot.sh"

  run copilot -u work --resume abc
  assert_success
  assert_line "COPILOT_HOME=${dir}"
  assert_line 'COPILOT_PROFILE_NAME=work'
  assert_line '--resume'
  assert_line 'abc'
  refute_line '-u'
  refute_line 'work'
}

@test "30-copilot: -u=<name> form behaves identically" {
  local dir
  dir="$(make_profile work)"
  source "${REPO_ROOT}/plugins/30-copilot.sh"

  run copilot -u=work --resume
  assert_success
  assert_line "COPILOT_HOME=${dir}"
  assert_line '--resume'
  refute_line '-u=work'
}

@test "30-copilot: named profile adds ~/.agents/skills to COPILOT_SKILLS_DIRS" {
  make_profile work >/dev/null
  mkdir -p "${HOME}/.agents/skills"
  export COPILOT_SKILLS_DIRS=/extra/skills
  source "${REPO_ROOT}/plugins/30-copilot.sh"

  run copilot -u work
  assert_success
  assert_line "COPILOT_SKILLS_DIRS=${HOME}/.agents/skills,/extra/skills"
}

@test "30-copilot: default profile leaves COPILOT_SKILLS_DIRS alone" {
  mkdir -p "${HOME}/.agents/skills"
  source "${REPO_ROOT}/plugins/30-copilot.sh"

  run copilot
  assert_success
  assert_line 'COPILOT_SKILLS_DIRS='
}

@test "30-copilot: named profile without ~/.agents/skills leaves COPILOT_SKILLS_DIRS unset" {
  make_profile work >/dev/null
  source "${REPO_ROOT}/plugins/30-copilot.sh"

  run copilot -u work
  assert_success
  assert_line 'COPILOT_SKILLS_DIRS='
}

@test "30-copilot: tool-permissions become flags before the user's args" {
  local dir
  dir="$(make_profile work)"
  cat >"${dir}/tool-permissions" <<'EOF'
# read-only allowlist

  allow shell(git status)
allow   shell(ls:*)
deny read(.env)
EOF
  source "${REPO_ROOT}/plugins/30-copilot.sh"

  run copilot -u work -p hi
  assert_success
  assert_equal "$(cat "${BATS_TEST_TMPDIR}/copilot-calls")" \
    '--disable-client-telemetry --allow-tool=shell(git status) --allow-tool=shell(ls:*) --deny-tool=read(.env) -p hi'
}

@test "30-copilot: unknown verb in tool-permissions fails without running copilot" {
  local dir
  dir="$(make_profile work)"
  printf 'allow shell(ls)\npermit shell(rm)\n' >"${dir}/tool-permissions"
  source "${REPO_ROOT}/plugins/30-copilot.sh"

  run copilot -u work
  assert_failure
  assert_output --partial "tool-permissions:2: expected 'allow' or 'deny', got 'permit'"
  [ ! -f "${BATS_TEST_TMPDIR}/copilot-calls" ]
}

@test "30-copilot: rule without a pattern fails" {
  local dir
  dir="$(make_profile work)"
  printf 'deny\n' >"${dir}/tool-permissions"
  source "${REPO_ROOT}/plugins/30-copilot.sh"

  run copilot -u work
  assert_failure
  assert_output --partial "tool-permissions:1: missing pattern after 'deny'"
}

@test "30-copilot: sources profile env file before exec" {
  make_profile work 'export GH_HOST=example.test' >/dev/null
  source "${REPO_ROOT}/plugins/30-copilot.sh"

  run copilot -u work
  assert_success
  assert_line 'GH_HOST=example.test'
}

@test "30-copilot: subshell isolates env - caller's shell unchanged" {
  local dir
  dir="$(make_profile work 'export GH_HOST=example.test')"
  printf 'allow shell(ls)\n' >"${dir}/tool-permissions"
  mkdir -p "${HOME}/.agents/skills"
  source "${REPO_ROOT}/plugins/30-copilot.sh"

  unset GH_HOST
  copilot -u work >/dev/null
  [ -z "${COPILOT_HOME:-}" ]
  [ -z "${COPILOT_PROFILE_NAME:-}" ]
  [ -z "${COPILOT_SKILLS_DIRS:-}" ]
  [ -z "${GH_HOST:-}" ]
  [ -z "${__dot_copilot_flags[*]:-}" ]
}

@test "30-copilot: missing profile directory is created on demand" {
  source "${REPO_ROOT}/plugins/30-copilot.sh"

  local dir="${XDG_CONFIG_HOME}/copilot-fresh"
  [ ! -d "${dir}" ]

  run copilot -u fresh
  assert_success
  assert_line "COPILOT_HOME=${dir}"
  [ -d "${dir}" ]
}

@test "30-copilot: -u without value fails" {
  source "${REPO_ROOT}/plugins/30-copilot.sh"

  run copilot -u
  assert_failure
  assert_output --partial 'requires a profile name'
}

@test "30-copilot: _dot_copilot completes profile names after -u" {
  make_profile work >/dev/null
  make_profile personal >/dev/null
  source "${REPO_ROOT}/plugins/30-copilot.sh"

  COMP_WORDS=(copilot -u '')
  COMP_CWORD=2
  COMPREPLY=()
  _dot_copilot

  local reply
  reply="$(printf '%s\n' "${COMPREPLY[@]}" | sort | tr '\n' ' ')"
  [ "${reply}" = "personal work " ]
}

@test "30-copilot: _dot_copilot delegates to the native completer elsewhere" {
  _fake_native_copilot() { COMPREPLY=(native-called); }
  complete -F _fake_native_copilot copilot
  source "${REPO_ROOT}/plugins/30-copilot.sh"

  COMP_WORDS=(copilot l)
  COMP_CWORD=1
  COMPREPLY=()
  _dot_copilot

  [ "${COMPREPLY[*]}" = "native-called" ]
}
