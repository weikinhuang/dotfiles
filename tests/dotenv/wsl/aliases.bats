#!/usr/bin/env bats
# Tests for dotenv/wsl/aliases.sh.
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
  source "${REPO_ROOT}/dotenv/wsl/aliases.sh"
}

@test "wsl/aliases: exposes winsudo aliases" {
  [[ "$(alias wudo)" == "alias wudo='winsudo'" ]]
  [[ "$(alias wsl-sudo)" == "alias wsl-sudo='winsudo'" ]]
}
