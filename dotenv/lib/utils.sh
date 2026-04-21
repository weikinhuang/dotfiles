# shellcheck shell=bash
# Provide shared utility functions for the dotfiles loader.
# SPDX-License-Identifier: MIT

# push a command to the prompt command
function internal::prompt-command-push() {
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

# Bash 3 lacks namerefs, so use eval to manipulate a named global array.
function internal::array-append-unique() {
  local array_name="$1"
  local value="$2"
  local item
  local -a entries=()

  eval "entries=(\"\${${array_name}[@]}\")"
  for item in "${entries[@]}"; do
    [[ "$item" == "$value" ]] && return 0
  done
  eval "${array_name}+=(\"\$value\")"
}

# internal prompt command stack to simplify the PROMPT_COMMAND variable
declare -a __dot_prompt_actions
function internal::prompt-action-push() {
  local cmd="${1/%;/}"
  internal::array-append-unique __dot_prompt_actions "${cmd}"
}
function internal::prompt-action-run() {
  # eval is required: entries may contain arguments (e.g. "history -a")
  # that break under direct invocation "$cmd"
  local cmd
  for cmd in "${__dot_prompt_actions[@]}"; do
    eval "$cmd"
  done
}

# Detect the VS Code-family terminal and cache the URL scheme for OSC 8
# hyperlinks.  When running inside a VS Code, Cursor, or VS Code Insiders
# integrated terminal, tools can emit vscode://, cursor://, or
# vscode-insiders:// file links that the editor opens natively -- even over
# SSH or WSL where file:// URLs are unreachable.  An explicit
# DOT_HYPERLINK_SCHEME overrides auto-detection.
__dot_hyperlink_scheme=""
if [[ -n "${DOT_HYPERLINK_SCHEME:-}" ]]; then
  __dot_hyperlink_scheme="${DOT_HYPERLINK_SCHEME}"
elif [[ "${TERM_PROGRAM:-}" == "vscode" ]]; then
  if [[ "${GIT_ASKPASS:-}" == *"/.vscode-server-insiders/"* ]] \
    || [[ "${GIT_ASKPASS:-}" == *"/Visual Studio Code - Insiders.app/"* ]]; then
    __dot_hyperlink_scheme="vscode-insiders"
  elif [[ "${GIT_ASKPASS:-}" == *"/.cursor-server/"* ]] \
    || [[ "${GIT_ASKPASS:-}" == *"/Cursor.app/"* ]]; then
    __dot_hyperlink_scheme="cursor"
  else
    __dot_hyperlink_scheme="vscode"
  fi
fi

# Build a vscode-remote:// URI prefix for tools that support custom hyperlink
# formats (ripgrep, delta).  file:// OSC 8 links are broken in VS Code remote
# terminals (WSL/SSH), but {scheme}://vscode-remote/{authority}{path}:{line}
# URIs work and open the file in the existing editor window.
# Requires __dot_hyperlink_scheme plus the remote context (WSL_DISTRO_NAME or
# DOT_HYPERLINK_SSH_HOST).
__dot_hyperlink_vscode_remote_prefix=""
if [[ -n "${__dot_hyperlink_scheme}" ]]; then
  if [[ -n "${DOT___IS_WSL:-}" ]] && [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
    __dot_hyperlink_vscode_remote_prefix="${__dot_hyperlink_scheme}://vscode-remote/wsl+${WSL_DISTRO_NAME}"
  elif [[ -n "${DOT___IS_SSH:-}" ]] && [[ -n "${DOT_HYPERLINK_SSH_HOST:-}" ]]; then
    __dot_hyperlink_vscode_remote_prefix="${__dot_hyperlink_scheme}://vscode-remote/ssh-remote+${DOT_HYPERLINK_SSH_HOST}"
  fi
fi

# helper function get the closest base editor (memoized after first call)
__dot_find_editor_result=
function internal::find-editor() {
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

  if [[ -z "${DOT___IS_SSH}" ]]; then
    if command -v code-insiders &>/dev/null || [[ "${PATH}" == */.vscode-server-insiders/bin/* ]]; then
      editor="code-insiders --wait"
      found_editor=1
    elif command -v cursor &>/dev/null || [[ "${PATH}" == */.cursor-server/bin/* ]]; then
      editor="cursor --wait"
      found_editor=1
    elif command -v code &>/dev/null || [[ "${PATH}" == */.vscode-server/bin/* ]]; then
      editor="code --wait"
      found_editor=1
    elif [[ -n "${DOT___IS_WSL}" ]] \
      && command -v npp &>/dev/null; then
      editor="npp"
      found_editor=1
    fi

    if [[ "${found_editor}" -eq 1 ]]; then
      __dot_find_editor_result="${editor}"
      echo "${editor}"
      return
    fi
  fi

  if command -v nvim &>/dev/null; then
    editor="nvim"
  elif command -v vim &>/dev/null; then
    editor="vim"
  fi

  __dot_find_editor_result="${editor}"
  echo "${editor}"
}

# Cache writes should fail quietly so readonly filesystems do not spam startup.
function internal::cache-dir-prepare() {
  local cache_dir="${1%/*}"

  [[ -d "${cache_dir}" ]] && return 0
  mkdir -p "${cache_dir}" 2>/dev/null
}

# Cache and source shell init scripts with version-based invalidation
# Usage: internal::cached-eval <tool> <generate-cmd>
function internal::cache-write-atomic() {
  local cache_file="$1"
  local gen_cmd="$2"
  local tmp_file

  internal::cache-dir-prepare "${cache_file}" || return 1
  tmp_file="$(mktemp "${cache_file}.XXXXXX" 2>/dev/null)" || return 1
  if eval "$gen_cmd" 2>/dev/null >"${tmp_file}"; then
    if mv -f "${tmp_file}" "${cache_file}" 2>/dev/null; then
      return 0
    fi
  fi
  rm -f "${tmp_file}" 2>/dev/null || true
  return 1
}

function internal::cache-refresh-async() {
  local cache_file="$1"
  local gen_cmd="$2"
  local bg_pid

  internal::cache-write-atomic "$cache_file" "$gen_cmd" >/dev/null 2>&1 &
  bg_pid=$!
  # Avoid interactive "Done" job notifications at the prompt.
  if [[ "$(type -t disown 2>/dev/null)" == "builtin" ]]; then
    disown "${bg_pid}" 2>/dev/null || true
  fi
}

function internal::cached-eval() {
  local tool="$1"
  local gen_cmd="$2"
  local cache_file="${DOTFILES__CONFIG_DIR}/cache/${tool}.init.bash"

  if [[ -f "$cache_file" ]]; then
    # shellcheck source=/dev/null
    source "$cache_file"
    local tool_bin
    tool_bin="$(command -v "$tool" 2>/dev/null)" || true
    if [[ -n "$tool_bin" && "$tool_bin" -nt "$cache_file" ]]; then
      internal::cache-refresh-async "$cache_file" "$gen_cmd"
    fi
  else
    if internal::cache-write-atomic "$cache_file" "$gen_cmd"; then
      # shellcheck source=/dev/null
      source "$cache_file"
    fi
  fi
}

# Cache and source shell completions with version-based invalidation
# Usage: internal::cached-completion <tool> <generate-cmd>
function internal::cached-completion() {
  local tool="$1"
  local gen_cmd="$2"
  local cache_file="${DOTFILES__CONFIG_DIR}/cache/completions/${tool}.bash"

  if [[ -f "$cache_file" ]]; then
    # shellcheck source=/dev/null
    source "$cache_file"
    local tool_bin
    tool_bin="$(command -v "$tool" 2>/dev/null)" || true
    if [[ -n "$tool_bin" && "$tool_bin" -nt "$cache_file" ]]; then
      internal::cache-refresh-async "$cache_file" "$gen_cmd"
    fi
  else
    if internal::cache-write-atomic "$cache_file" "$gen_cmd"; then
      # shellcheck source=/dev/null
      source "$cache_file"
    fi
  fi
}
