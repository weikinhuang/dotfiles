# shellcheck shell=bash

# push a command to the prompt command
function __push_prompt_command() {
  local cmd="${1/%;/}"
  local existing="${PROMPT_COMMAND/%;/}"
  local result="" part=""
  while [[ -n "$existing" ]]; do
    part="${existing%%;*}"
    part="${part#"${part%%[![:space:]]*}"}"
    part="${part%"${part##*[![:space:]]}"}"
    if [[ -n "$part" ]] && [[ "$part" != "$cmd" ]]; then
      result="${result}${part};"
    fi
    if [[ "$existing" == *";"* ]]; then
      existing="${existing#*;}"
    else
      break
    fi
  done
  PROMPT_COMMAND="${result}${cmd};"
}

# internal prompt command stack to simplify the PROMPT_COMMAND variable
declare -a __prompt_actions
function __push_internal_prompt_command() {
  local cmd="${1/%;/}"
  __prompt_actions+=("${cmd}")
}
function __run_prompt_command() {
  # eval is required: entries may contain arguments (e.g. "history -a")
  # that break under direct invocation "$cmd"
  local cmd
  for cmd in "${__prompt_actions[@]}"; do
    eval "$cmd"
  done
}

# helper function get the closest base editor
function __find_editor() {
  local editor=""
  if command -v vi &>/dev/null; then
    editor=vi
  elif command -v nano &>/dev/null; then
    editor=nano
  fi

  if command -v code-insiders &>/dev/null && [[ "$PATH" == */.vscode-server-insiders/bin/* ]] && [[ "$PATH" != */.vscode-server/bin/* ]]; then
    editor="code-insiders --wait"
  elif command -v code &>/dev/null && [[ "$PATH" == */.vscode-server/bin/* ]]; then
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

# Cache and source shell completions with version-based invalidation
# Usage: __dot_cached_completion <tool> <generate-cmd>
function __dot_cached_completion() {
  local tool="$1"
  local gen_cmd="$2"
  local cache_file="${DOTFILES__CONFIG_DIR}/cache/completions/${tool}.bash"

  if [[ -f "$cache_file" ]]; then
    # shellcheck source=/dev/null
    source "$cache_file"
    local tool_bin
    tool_bin="$(command -v "$tool" 2>/dev/null)" || true
    if [[ -n "$tool_bin" && "$tool_bin" -nt "$cache_file" ]]; then
      (eval "$gen_cmd" 2>/dev/null > "$cache_file" &)
    fi
  else
    mkdir -p "${cache_file%/*}"
    eval "$gen_cmd" 2>/dev/null | tee "$cache_file" >/dev/null
    # shellcheck source=/dev/null
    source "$cache_file"
  fi
}
