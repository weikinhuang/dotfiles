#!/usr/bin/env bats

setup() {
  load '../../helpers/common'
  source "${REPO_ROOT}/dotenv/linux/exports.sh"
}

@test "linux/exports: sets PROC_CORES from /proc/cpuinfo" {
  [[ "${PROC_CORES}" =~ ^[0-9]+$ ]]
  [[ "${PROC_CORES}" -ge 1 ]]
}
