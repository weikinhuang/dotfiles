# shellcheck shell=bash
# Export WSL-specific environment defaults.
# SPDX-License-Identifier: MIT

# include the system path for easy access to tools, it is already included in the 2018 fall creator's update
__dot_wsl_win_root="$(wslpath -u c:/ 2>/dev/null)" || __dot_wsl_win_root="/mnt/c/"
__dot_wsl_win_root="${__dot_wsl_win_root%/}/"
# case-insensitive + trailing-slash-aware check: WSL interop may already
# have these on PATH with different casing (e.g. /mnt/c/WINDOWS/...)
internal::wsl-has-path() {
  local lc_val="${1,,}"
  local lc_path=":${PATH,,}:"

  lc_val="${lc_val%/}"
  [[ "${lc_path}" == *":${lc_val}:"* || "${lc_path}" == *":${lc_val}/:"* ]]
}
internal::wsl-has-path "${__dot_wsl_win_root}Windows/system32" || internal::path-push "${__dot_wsl_win_root}Windows/system32"
internal::wsl-has-path "${__dot_wsl_win_root}Windows" || internal::path-push "${__dot_wsl_win_root}Windows"
internal::wsl-has-path "${__dot_wsl_win_root}Windows/System32/Wbem" || internal::path-push "${__dot_wsl_win_root}Windows/System32/Wbem"
internal::wsl-has-path "${__dot_wsl_win_root}Windows/System32/WindowsPowerShell/v1.0" || internal::path-push "${__dot_wsl_win_root}Windows/System32/WindowsPowerShell/v1.0"
unset -f internal::wsl-has-path
unset __dot_wsl_win_root

# set default browser to native behavior
export BROWSER=winstart
