# shellcheck shell=bash
# Provide shared utility functions for the dotfiles loader.
# SPDX-License-Identifier: MIT

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

# helper function get the closest base editor (memoized after first call)
__dot_find_editor_result=
function __find_editor() {
  if [[ -n "${__dot_find_editor_result}" ]]; then
    echo "${__dot_find_editor_result}"
    return
  fi

  local editor=""
  local found_editor=0
  # set a reasonable default
  if command -v vi &>/dev/null; then
    editor="$(command -v vi)"
  elif command -v nano &>/dev/null; then
    editor="$(command -v nano)"
  fi

  # check if we are running in a vscode environment
  if [[ "${TERM_PROGRAM}" == "vscode" ]]; then
    if command -v code-insiders &>/dev/null && [[ "${GIT_ASKPASS}" == *"/.vscode-server-insiders/"* ]] \
      || [[ "${GIT_ASKPASS}" == *"/Visual Studio Code - Insiders.app/"* ]]; then
      editor="code-insiders --wait"
      found_editor=1
    elif command -v cursor &>/dev/null && [[ "${GIT_ASKPASS}" == *"/.cursor-server/"* ]] \
      || [[ "${GIT_ASKPASS}" == *"/Cursor.app/"* ]]; then
      editor="cursor --wait"
      found_editor=1
    elif command -v code &>/dev/null && [[ "${GIT_ASKPASS}" == *"/.vscode-server/"* ]] \
      || [[ "${GIT_ASKPASS}" == *"/Visual Studio Code.app/"* ]]; then
      editor="code --wait"
      found_editor=1
    fi

    if [[ "${found_editor}" -eq 1 ]]; then
      __dot_find_editor_result="${editor}"
      echo "${editor}"
      return
    fi
  fi

  if command -v code-insiders &>/dev/null || [[ "${PATH}" == */.vscode-server-insiders/bin/* ]]; then
    editor="code-insiders --wait"
  elif command -v cursor &>/dev/null || [[ "${PATH}" == */.cursor-server/bin/* ]]; then
    editor="cursor --wait"
  elif command -v code &>/dev/null || [[ "${PATH}" == */.vscode-server/bin/* ]]; then
    editor="code --wait"
  elif [[ -n "${DOT___IS_WSL}" ]] \
    && command -v npp &>/dev/null; then
    editor="npp"
  elif command -v nvim &>/dev/null; then
    editor="nvim"
  elif command -v vim &>/dev/null; then
    editor="vim"
  fi

  __dot_find_editor_result="${editor}"
  echo "${editor}"
}

# Cache writes should fail quietly so readonly filesystems do not spam startup.
function __dot_cache_prepare_dir() {
  local cache_dir="${1%/*}"

  [[ -d "${cache_dir}" ]] && return 0
  mkdir -p "${cache_dir}" 2>/dev/null
}

# Cache and source shell init scripts with version-based invalidation
# Usage: __dot_cached_eval <tool> <generate-cmd>
function __dot_cache_write_atomic() {
  local cache_file="$1"
  local gen_cmd="$2"
  local tmp_file="${cache_file}.tmp.$$.$RANDOM"

  __dot_cache_prepare_dir "${cache_file}" || return 1
  if eval "$gen_cmd" 2>/dev/null >"${tmp_file}"; then
    if mv -f "${tmp_file}" "${cache_file}" 2>/dev/null; then
      return 0
    fi
  fi
  rm -f "${tmp_file}" 2>/dev/null || true
  return 1
}

function __dot_cache_refresh_async() {
  local cache_file="$1"
  local gen_cmd="$2"
  local bg_pid

  __dot_cache_write_atomic "$cache_file" "$gen_cmd" >/dev/null 2>&1 &
  bg_pid=$!
  # Avoid interactive "Done" job notifications at the prompt.
  if [[ "$(type -t disown 2>/dev/null)" == "builtin" ]]; then
    disown "${bg_pid}" 2>/dev/null || true
  fi
}

function __dot_cached_eval() {
  local tool="$1"
  local gen_cmd="$2"
  local cache_file="${DOTFILES__CONFIG_DIR}/cache/${tool}.init.bash"

  if [[ -f "$cache_file" ]]; then
    # shellcheck source=/dev/null
    source "$cache_file"
    local tool_bin
    tool_bin="$(command -v "$tool" 2>/dev/null)" || true
    if [[ -n "$tool_bin" && "$tool_bin" -nt "$cache_file" ]]; then
      __dot_cache_refresh_async "$cache_file" "$gen_cmd"
    fi
  else
    if __dot_cache_write_atomic "$cache_file" "$gen_cmd"; then
      # shellcheck source=/dev/null
      source "$cache_file"
    fi
  fi
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
      __dot_cache_refresh_async "$cache_file" "$gen_cmd"
    fi
  else
    if __dot_cache_write_atomic "$cache_file" "$gen_cmd"; then
      # shellcheck source=/dev/null
      source "$cache_file"
    fi
  fi
}
