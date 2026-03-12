#!/usr/bin/env bats
# Tests for dotenv/linux/completion.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
}

@test "linux/completion: sourcing succeeds when bash_completion is present or absent" {
  run bash -c 'source "$1"' _ "${REPO_ROOT}/dotenv/linux/completion.sh"
  assert_success
}

@test "linux/completion: sources bash_completion when the file exists" {
  local completion_file="${BATS_TEST_TMPDIR}/bash_completion"
  printf 'DOT_TEST_BASH_COMPLETION=loaded\n' >"${completion_file}"

  run bash -c 'source <(sed "s#/etc/bash_completion#$2#" "$1"); printf "%s" "${DOT_TEST_BASH_COMPLETION:-}"' \
    _ "${REPO_ROOT}/dotenv/linux/completion.sh" "${completion_file}"
  assert_success
  assert_output "loaded"
}
