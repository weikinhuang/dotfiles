# shellcheck shell=bash
# Define WSL-specific shell functions.
# SPDX-License-Identifier: MIT

# run a command under the windows shell
function cmd0() {
  cmd.exe /c "$@" | sed 's/\r$//'
  return "${PIPESTATUS[0]}"
}
