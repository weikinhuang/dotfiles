#!/usr/bin/env bats

setup() {
  load '../../helpers/common'
  source "${REPO_ROOT}/dotenv/wsl/aliases.sh"
}

@test "wsl/aliases: exposes winsudo aliases" {
  [[ "$(alias wudo)" == "alias wudo='winsudo'" ]]
  [[ "$(alias wsl-sudo)" == "alias wsl-sudo='winsudo'" ]]
}
