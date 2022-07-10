# shellcheck shell=bash

# push a command to the prompt command
function __push_prompt_command() {
  local command="${1/%;/}"
  PROMPT_COMMAND="$(echo "$(echo "${PROMPT_COMMAND/%;/}" | tr ';' '\n' | grep -v -F "${command}" | grep -v '^ *$' | tr '\n' ';')${command};" | sed 's/;;/;/' | sed 's/^;//')"
}

# internal prompt command stack to simplify the PROMPT_COMMAND variable
declare -a __prompt_actions
function __push_internal_prompt_command() {
  local command="${1/%;/}"
  __prompt_actions+=("${command}")
}
function __run_prompt_command() {
  for l in "${__prompt_actions[@]}"; do
    eval "$l"
  done
}

# helper function get the closest base editor
function __find_editor() {
  local editor
  # shellcheck disable=SC2209
  editor="$(which vi nano | head -1)"

  if command -v code-insiders &>/dev/null && echo "${PATH}" | grep -q "/.vscode-server-insiders/bin/" && ! (echo "${PATH}" | grep -q "/.vscode-server/bin/"); then
    editor="code-insiders --wait"
  elif command -v code &>/dev/null && echo "${PATH}" | grep -q "/.vscode-server/bin/"; then
    editor="code --wait"
  elif [[ -n "${DOT___IS_WSL}" ]] && command -v npp &>/dev/null; then
    editor=npp
  elif command -v nvim &>/dev/null; then
    editor=nvim
  elif command -v vim &>/dev/null; then
    editor=vim
  fi

  echo "${editor}"
}
