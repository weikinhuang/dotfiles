#!/usr/bin/env bats
# Tests for plugins/30-pi.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
  stub_pi_env_dump
}

# Stubs `pi` so every invocation prints the env vars we care about plus
# one line per forwarded arg. Lets tests assert on both env propagation and
# argument forwarding from the wrapper function.
stub_pi_env_dump() {
  stub_command pi <<'EOF'
#!/usr/bin/env bash
printf 'PI_CODING_AGENT_DIR=%s\n' "${PI_CODING_AGENT_DIR:-}"
printf 'PI_CODING_AGENT_PROFILE_NAME=%s\n' "${PI_CODING_AGENT_PROFILE_NAME:-}"
printf 'ANTHROPIC_API_KEY=%s\n' "${ANTHROPIC_API_KEY:-}"
printf 'ARGS:\n'
printf '%s\n' "$@"
EOF
}

make_profile() {
  local name="$1"
  local dir="${XDG_CONFIG_HOME}/pi-${name}"
  mkdir -p "${dir}"
  if [[ -n "${2:-}" ]]; then
    printf '%s\n' "$2" >"${dir}/env"
  fi
  printf '%s' "${dir}"
}

@test "30-pi: no -u forwards args verbatim and leaves env unset" {
  source "${REPO_ROOT}/plugins/30-pi.sh"

  run pi --print hello world
  assert_success
  assert_line 'PI_CODING_AGENT_DIR='
  assert_line 'PI_CODING_AGENT_PROFILE_NAME='
  assert_line 'ANTHROPIC_API_KEY='
  assert_line '--print'
  assert_line 'hello'
  assert_line 'world'
}

@test "30-pi: no -u sources env from default agent dir" {
  mkdir -p "${HOME}/.pi/agent"
  printf 'export ANTHROPIC_API_KEY=default-key\n' >"${HOME}/.pi/agent/env"
  source "${REPO_ROOT}/plugins/30-pi.sh"

  run pi --print
  assert_success
  assert_line 'PI_CODING_AGENT_DIR='
  assert_line 'PI_CODING_AGENT_PROFILE_NAME='
  assert_line 'ANTHROPIC_API_KEY=default-key'
}

@test "30-pi: no -u honours PI_CODING_AGENT_DIR override for default env" {
  local dir="${BATS_TEST_TMPDIR}/custom-pi"
  mkdir -p "${dir}"
  printf 'export ANTHROPIC_API_KEY=custom-key\n' >"${dir}/env"
  export PI_CODING_AGENT_DIR="${dir}"
  source "${REPO_ROOT}/plugins/30-pi.sh"

  run pi --print
  assert_success
  assert_line 'ANTHROPIC_API_KEY=custom-key'
}

@test "30-pi: -u sets PI_CODING_AGENT_DIR and profile name, forwards remaining args" {
  local dir
  dir="$(make_profile work)"
  source "${REPO_ROOT}/plugins/30-pi.sh"

  run pi -u work --print hello
  assert_success
  assert_line "PI_CODING_AGENT_DIR=${dir}"
  assert_line 'PI_CODING_AGENT_PROFILE_NAME=work'
  assert_line '--print'
  assert_line 'hello'
  refute_line '-u'
  refute_line 'work'
}

@test "30-pi: -u=<name> form behaves identically to -u <name>" {
  local dir
  dir="$(make_profile work)"
  source "${REPO_ROOT}/plugins/30-pi.sh"

  run pi -u=work --print
  assert_success
  assert_line "PI_CODING_AGENT_DIR=${dir}"
  assert_line 'PI_CODING_AGENT_PROFILE_NAME=work'
  assert_line '--print'
  refute_line '-u=work'
}

@test "30-pi: sources profile env file before exec" {
  make_profile work 'export ANTHROPIC_API_KEY=profile-key' >/dev/null
  source "${REPO_ROOT}/plugins/30-pi.sh"

  run pi -u work
  assert_success
  assert_line 'ANTHROPIC_API_KEY=profile-key'
}

@test "30-pi: subshell isolates env - caller's shell unchanged" {
  make_profile work 'export ANTHROPIC_API_KEY=profile-key' >/dev/null
  source "${REPO_ROOT}/plugins/30-pi.sh"

  unset PI_CODING_AGENT_DIR PI_CODING_AGENT_PROFILE_NAME ANTHROPIC_API_KEY
  pi -u work >/dev/null
  [ -z "${PI_CODING_AGENT_DIR:-}" ]
  [ -z "${PI_CODING_AGENT_PROFILE_NAME:-}" ]
  [ -z "${ANTHROPIC_API_KEY:-}" ]
}

@test "30-pi: missing profile directory is created on demand" {
  source "${REPO_ROOT}/plugins/30-pi.sh"

  local dir="${XDG_CONFIG_HOME}/pi-fresh"
  [ ! -d "${dir}" ]

  run pi -u fresh --print
  assert_success
  assert_line "PI_CODING_AGENT_DIR=${dir}"
  assert_line 'PI_CODING_AGENT_PROFILE_NAME=fresh'
  assert_line '--print'
  [ -d "${dir}" ]
}

@test "30-pi: -u without value fails" {
  source "${REPO_ROOT}/plugins/30-pi.sh"

  run pi -u
  assert_failure
  assert_output --partial 'requires a profile name'
}

@test "30-pi: _dot_pi completes profile names after -u" {
  make_profile work >/dev/null
  make_profile personal >/dev/null
  source "${REPO_ROOT}/plugins/30-pi.sh"

  COMP_WORDS=(pi -u '')
  COMP_CWORD=2
  COMPREPLY=()
  _dot_pi

  # Sort for stable comparison regardless of glob order.
  local reply
  reply="$(printf '%s\n' "${COMPREPLY[@]}" | sort | tr '\n' ' ')"
  [ "${reply}" = "personal work " ]
}
