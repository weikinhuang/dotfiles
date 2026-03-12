#!/usr/bin/env bats
# Tests for dotenv/completion.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../helpers/common'
  source "${REPO_ROOT}/dotenv/completion.sh"
}

@test "completion: registers sudo completion as command-and-file completion" {
  [[ "$(complete -p sudo)" == "complete -c -f sudo" ]]
}
