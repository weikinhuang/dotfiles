#!/usr/bin/env bats
# Tests for dotenv/lib/prompt.sh (segment registry API).
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
  setup_test_bin
  setup_isolated_home

  unset DOT_PS1_SEGMENTS
  unset DOT_SUDO_PS1_SEGMENTS
  unset DOT_PS1_MONOCHROME
  source "${REPO_ROOT}/dotenv/lib/prompt.sh"
}

@test "prompt-lib: default DOT_PS1_SEGMENTS is populated" {
  local expected="exit_status bg_jobs time loadavg user session_host workdir dirinfo git exec_time"
  [ "${DOT_PS1_SEGMENTS[*]}" = "${expected}" ]
}

@test "prompt-lib: default DOT_SUDO_PS1_SEGMENTS is populated" {
  local expected="exit_status bg_jobs time user session_host workdir"
  [ "${DOT_SUDO_PS1_SEGMENTS[*]}" = "${expected}" ]
}

@test "prompt-lib: user-defined DOT_PS1_SEGMENTS is preserved" {
  DOT_PS1_SEGMENTS=(time user git)
  source "${REPO_ROOT}/dotenv/lib/prompt.sh"

  [ "${DOT_PS1_SEGMENTS[*]}" = "time user git" ]
}

@test "prompt-lib: segment-add appends to end by default" {
  internal::ps1-segment-add venv

  [ "${DOT_PS1_SEGMENTS[${#DOT_PS1_SEGMENTS[@]}-1]}" = "venv" ]
}

@test "prompt-lib: segment-add --after inserts after named segment" {
  internal::ps1-segment-add venv --after user

  local found=0 idx
  for idx in "${!DOT_PS1_SEGMENTS[@]}"; do
    if [[ "${DOT_PS1_SEGMENTS[$idx]}" == "user" ]]; then
      [ "${DOT_PS1_SEGMENTS[$((idx + 1))]}" = "venv" ]
      found=1
      break
    fi
  done
  [ "$found" -eq 1 ]
}

@test "prompt-lib: segment-add --before inserts before named segment" {
  internal::ps1-segment-add venv --before git

  local found=0 idx
  for idx in "${!DOT_PS1_SEGMENTS[@]}"; do
    if [[ "${DOT_PS1_SEGMENTS[$idx]}" == "venv" ]]; then
      [ "${DOT_PS1_SEGMENTS[$((idx + 1))]}" = "git" ]
      found=1
      break
    fi
  done
  [ "$found" -eq 1 ]
}

@test "prompt-lib: segment-add replaces existing entry at new position" {
  internal::ps1-segment-add time --after git

  local count=0 item
  for item in "${DOT_PS1_SEGMENTS[@]}"; do
    [[ "$item" == "time" ]] && count=$((count + 1))
  done
  [ "$count" -eq 1 ]

  local found=0 idx
  for idx in "${!DOT_PS1_SEGMENTS[@]}"; do
    if [[ "${DOT_PS1_SEGMENTS[$idx]}" == "git" ]]; then
      [ "${DOT_PS1_SEGMENTS[$((idx + 1))]}" = "time" ]
      found=1
      break
    fi
  done
  [ "$found" -eq 1 ]
}

@test "prompt-lib: segment-remove removes named segment" {
  internal::ps1-segment-remove time

  local item
  for item in "${DOT_PS1_SEGMENTS[@]}"; do
    [[ "$item" != "time" ]]
  done
}

@test "prompt-lib: segment-add --sudo targets DOT_SUDO_PS1_SEGMENTS" {
  internal::ps1-segment-add venv --sudo --after user

  local found=0 idx
  for idx in "${!DOT_SUDO_PS1_SEGMENTS[@]}"; do
    if [[ "${DOT_SUDO_PS1_SEGMENTS[$idx]}" == "user" ]]; then
      [ "${DOT_SUDO_PS1_SEGMENTS[$((idx + 1))]}" = "venv" ]
      found=1
      break
    fi
  done
  [ "$found" -eq 1 ]
}

@test "prompt-lib: segment-remove --sudo targets DOT_SUDO_PS1_SEGMENTS" {
  internal::ps1-segment-remove time --sudo

  local item
  for item in "${DOT_SUDO_PS1_SEGMENTS[@]}"; do
    [[ "$item" != "time" ]]
  done
}

@test "prompt-lib: segment-add with non-existent reference falls back to append" {
  internal::ps1-segment-add venv --after nonexistent

  [ "${DOT_PS1_SEGMENTS[${#DOT_PS1_SEGMENTS[@]}-1]}" = "venv" ]
}

@test "prompt-lib: resolve-color 3-arg form assigns via printf -v" {
  unset DOT_PS1_COLOR_USER
  local result=""
  internal::ps1-resolve-color DOT_PS1_COLOR_USER 'fallback' result

  [ "$result" = "fallback" ]
}

@test "prompt-lib: resolve-color returns default when var unset" {
  unset DOT_PS1_COLOR_USER
  local result
  result="$(internal::ps1-resolve-color DOT_PS1_COLOR_USER 'fallback')"

  [ "$result" = "fallback" ]
}

@test "prompt-lib: resolve-color returns user override when set" {
  DOT_PS1_COLOR_USER='custom-color'
  local result
  result="$(internal::ps1-resolve-color DOT_PS1_COLOR_USER 'fallback')"

  [ "$result" = "custom-color" ]
}

@test "prompt-lib: resolve-color returns empty in monochrome mode" {
  DOT_PS1_MONOCHROME=1
  local result
  result="$(internal::ps1-resolve-color DOT_PS1_COLOR_USER 'fallback')"

  [ -z "$result" ]
}

@test "prompt-lib: __dot_ps1_bold and __dot_ps1_reset are set" {
  [[ -n "${__dot_ps1_bold}" ]]
  [[ -n "${__dot_ps1_reset}" ]]
}
