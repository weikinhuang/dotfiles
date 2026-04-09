# shellcheck shell=bash
# Define WSL-specific shell functions.
# SPDX-License-Identifier: MIT

# run a command under the windows shell
function cmd0() {
  cmd.exe /c "$@" | sed 's/\r$//'
  return "${PIPESTATUS[0]}"
}

# Rewrite file:// URLs in OSC 8 hyperlinks to use the wsl.localhost authority
# so Windows apps can resolve WSL paths.  When stdout is not a terminal the
# command is executed directly with hyperlink flags stripped so tools fall
# back to their default tty auto-detection.
function internal::osc8-wsl-rewrite() {
  if [[ ! -t 1 ]]; then
    local __dot_args=()
    local __dot_arg
    for __dot_arg in "$@"; do
      case "${__dot_arg}" in
        --hyperlink | --hyperlink=*) ;;
        *) __dot_args+=("${__dot_arg}") ;;
      esac
    done
    "${__dot_args[@]}"
    return
  fi
  COLUMNS="${COLUMNS:-80}" "$@" --color=always \
    | command sed "s,\x1b]8;;file://[^/]*/,\x1b]8;;file://wsl.localhost/${WSL_DISTRO_NAME}/,g"
  return "${PIPESTATUS[0]}"
}
