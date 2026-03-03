# shellcheck shell=bash

# include the system path for easy access to tools, it is already included in the 2018 fall creator's update
_win_root="$(wslpath -u c:/ 2>/dev/null)" || _win_root="/mnt/c/"
_win_root="${_win_root%/}/"
# case-insensitive check: System32 may already be on PATH from WSL auto-mount
if [[ ":${PATH,,}:" != *":${_win_root,,}windows/system32:"* ]]; then
  __push_path "${_win_root}Windows/system32"
fi
__push_path "${_win_root}Windows"
__push_path "${_win_root}Windows/System32/Wbem"
__push_path "${_win_root}Windows/System32/WindowsPowerShell/v1.0"
unset _win_root

# set default browser to native behavior
export BROWSER=winstart
