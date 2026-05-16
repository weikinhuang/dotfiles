#!/usr/bin/env bats
# Tests for plugins/30-claude.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  setup_plugin_test_env
  stub_claude_env_dump
}

# Stubs `claude` so every invocation prints the env vars we care about plus
# one line per forwarded arg. Lets tests assert on both env propagation and
# argument forwarding from the wrapper function.
stub_claude_env_dump() {
  stub_command claude <<'EOF'
#!/usr/bin/env bash
printf 'CLAUDE_CONFIG_DIR=%s\n' "${CLAUDE_CONFIG_DIR:-}"
printf 'CLAUDE_CODE_PROFILE_NAME=%s\n' "${CLAUDE_CODE_PROFILE_NAME:-}"
printf 'ANTHROPIC_BASE_URL=%s\n' "${ANTHROPIC_BASE_URL:-}"
printf 'ARGS:\n'
printf '%s\n' "$@"
EOF
}

make_profile() {
  local name="$1"
  local dir="${XDG_CONFIG_HOME}/claude-${name}"
  mkdir -p "${dir}"
  if [[ -n "${2:-}" ]]; then
    printf '%s\n' "$2" >"${dir}/env"
  fi
  printf '%s' "${dir}"
}

@test "30-claude: no -u forwards args verbatim and leaves env unset" {
  source "${REPO_ROOT}/plugins/30-claude.sh"

  run claude --print hello world
  assert_success
  assert_line 'CLAUDE_CONFIG_DIR='
  assert_line 'CLAUDE_CODE_PROFILE_NAME='
  assert_line 'ANTHROPIC_BASE_URL='
  assert_line '--print'
  assert_line 'hello'
  assert_line 'world'
}

@test "30-claude: no -u sources env from default config dir" {
  mkdir -p "${HOME}/.claude"
  printf 'export ANTHROPIC_BASE_URL=https://default.test\n' >"${HOME}/.claude/env"
  source "${REPO_ROOT}/plugins/30-claude.sh"

  run claude --print
  assert_success
  assert_line 'CLAUDE_CONFIG_DIR='
  assert_line 'CLAUDE_CODE_PROFILE_NAME='
  assert_line 'ANTHROPIC_BASE_URL=https://default.test'
}

@test "30-claude: no -u honours CLAUDE_CONFIG_DIR override for default env" {
  local dir="${BATS_TEST_TMPDIR}/custom-claude"
  mkdir -p "${dir}"
  printf 'export ANTHROPIC_BASE_URL=https://custom.test\n' >"${dir}/env"
  export CLAUDE_CONFIG_DIR="${dir}"
  source "${REPO_ROOT}/plugins/30-claude.sh"

  run claude --print
  assert_success
  assert_line 'ANTHROPIC_BASE_URL=https://custom.test'
}

@test "30-claude: -u sets CLAUDE_CONFIG_DIR and profile name, forwards remaining args" {
  local dir
  dir="$(make_profile work)"
  source "${REPO_ROOT}/plugins/30-claude.sh"

  run claude -u work --print hello
  assert_success
  assert_line "CLAUDE_CONFIG_DIR=${dir}"
  assert_line 'CLAUDE_CODE_PROFILE_NAME=work'
  assert_line '--print'
  assert_line 'hello'
  refute_line '-u'
  refute_line 'work'
}

@test "30-claude: -u=<name> form behaves identically to -u <name>" {
  local dir
  dir="$(make_profile work)"
  source "${REPO_ROOT}/plugins/30-claude.sh"

  run claude -u=work --print
  assert_success
  assert_line "CLAUDE_CONFIG_DIR=${dir}"
  assert_line 'CLAUDE_CODE_PROFILE_NAME=work'
  assert_line '--print'
  refute_line '-u=work'
}

@test "30-claude: sources profile env file before exec" {
  make_profile work 'export ANTHROPIC_BASE_URL=https://example.test' >/dev/null
  source "${REPO_ROOT}/plugins/30-claude.sh"

  run claude -u work
  assert_success
  assert_line 'ANTHROPIC_BASE_URL=https://example.test'
}

@test "30-claude: subshell isolates env - caller's shell unchanged" {
  make_profile work 'export ANTHROPIC_BASE_URL=https://example.test' >/dev/null
  source "${REPO_ROOT}/plugins/30-claude.sh"

  unset CLAUDE_CONFIG_DIR CLAUDE_CODE_PROFILE_NAME ANTHROPIC_BASE_URL
  claude -u work >/dev/null
  [ -z "${CLAUDE_CONFIG_DIR:-}" ]
  [ -z "${CLAUDE_CODE_PROFILE_NAME:-}" ]
  [ -z "${ANTHROPIC_BASE_URL:-}" ]
}

@test "30-claude: missing profile directory is created on demand" {
  source "${REPO_ROOT}/plugins/30-claude.sh"

  local dir="${XDG_CONFIG_HOME}/claude-fresh"
  [ ! -d "${dir}" ]

  run claude -u fresh --print
  assert_success
  assert_line "CLAUDE_CONFIG_DIR=${dir}"
  assert_line 'CLAUDE_CODE_PROFILE_NAME=fresh'
  assert_line '--print'
  [ -d "${dir}" ]
}

@test "30-claude: -u without value fails" {
  source "${REPO_ROOT}/plugins/30-claude.sh"

  run claude -u
  assert_failure
  assert_output --partial 'requires a profile name'
}

@test "30-claude: _dot_claude completes profile names after -u" {
  make_profile work >/dev/null
  make_profile personal >/dev/null
  source "${REPO_ROOT}/plugins/30-claude.sh"

  COMP_WORDS=(claude -u '')
  COMP_CWORD=2
  COMPREPLY=()
  _dot_claude

  # Sort for stable comparison regardless of glob order.
  local reply
  reply="$(printf '%s\n' "${COMPREPLY[@]}" | sort | tr '\n' ' ')"
  [ "${reply}" = "personal work " ]
}
