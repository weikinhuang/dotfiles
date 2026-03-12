#!/usr/bin/env bats
# Tests for dotenv/darwin/prompt.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
  source "${REPO_ROOT}/dotenv/darwin/prompt.sh"
}

@test "darwin/prompt: defines __ps1_proc_use with the vm.loadavg sysctl path" {
  [[ "$(declare -f __ps1_proc_use)" == *"/usr/sbin/sysctl -n vm.loadavg"* ]]
}

@test "darwin/prompt: ps1-proc-use parses the first load-average value" {
  run bash -c 'source <(sed "s#/usr/sbin/sysctl -n vm.loadavg#printf \"{ 1.23 1.45 1.67 }\"#" "$1"); __ps1_proc_use' \
    _ "${REPO_ROOT}/dotenv/darwin/prompt.sh"
  assert_success
  assert_output "1.23"
}
