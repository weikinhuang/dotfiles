# shellcheck shell=bash

# run a command under the windows shell
function cmd0() {
  cmd.exe /c "$@" | sed 's/\r$//'
  return "${PIPESTATUS[0]}"
}
