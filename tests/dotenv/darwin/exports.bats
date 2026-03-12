#!/usr/bin/env bats
# Tests for dotenv/darwin/exports.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
}

@test "darwin/exports: enables bash deprecation warning suppression" {
  run bash -c 'source <(sed "s#/usr/sbin/sysctl -n hw.ncpu#printf 8#" "$1"); printf "%s\n%s\n" "${BASH_SILENCE_DEPRECATION_WARNING:-}" "${PROC_CORES:-}"' \
    _ "${REPO_ROOT}/dotenv/darwin/exports.sh"
  assert_success
  assert_line --index 0 "1"
  assert_line --index 1 "8"
}
