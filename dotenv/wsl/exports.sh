# shellcheck shell=bash

# include the system path for easy access to tools, it is already included in the 2018 fall creator's update
_win_root="$(wslpath -u c:/ 2>/dev/null)" || _win_root="/mnt/c/"
_win_root="${_win_root%/}/"
# case-insensitive + trailing-slash-aware check: WSL interop may already
# have these on PATH with different casing (e.g. /mnt/c/WINDOWS/...)
__wsl_has_path() {
  local _lc_val="${1,,}"
  _lc_val="${_lc_val%/}"
  local _lc_path=":${PATH,,}:"
  [[ "${_lc_path}" == *":${_lc_val}:"* || "${_lc_path}" == *":${_lc_val}/:"* ]]
}
__wsl_has_path "${_win_root}Windows/system32" || __push_path "${_win_root}Windows/system32"
__wsl_has_path "${_win_root}Windows" || __push_path "${_win_root}Windows"
__wsl_has_path "${_win_root}Windows/System32/Wbem" || __push_path "${_win_root}Windows/System32/Wbem"
__wsl_has_path "${_win_root}Windows/System32/WindowsPowerShell/v1.0" || __push_path "${_win_root}Windows/System32/WindowsPowerShell/v1.0"
unset -f __wsl_has_path
unset _win_root

# set default browser to native behavior
export BROWSER=winstart
