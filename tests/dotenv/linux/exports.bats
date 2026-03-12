#!/usr/bin/env bats
# Tests for dotenv/linux/exports.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
  source "${REPO_ROOT}/dotenv/linux/exports.sh"
}

@test "linux/exports: sets PROC_CORES from /proc/cpuinfo" {
  [[ "${PROC_CORES}" =~ ^[0-9]+$ ]]
  [[ "${PROC_CORES}" -ge 1 ]]
}
