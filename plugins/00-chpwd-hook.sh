# shellcheck shell=bash
# Initialize chpwd hook support.
# SPDX-License-Identifier: MIT

# Avoid duplicate inclusion
if [[ -n "${__dot_chpwd_imported:-}" ]]; then
  return
fi
__dot_chpwd_imported="defined"

if ! declare -p chpwd_functions &>/dev/null; then
  # shellcheck disable=SC2034
  declare -a chpwd_functions
fi

__dot_chpwd_active=0
__dot_chpwd_last_pwd=
# execute dotfile load hooks
function internal::chpwd-hook() {
  local hook

  # Don't invoke chpwd if we are inside of another chpwd.
  if ((__dot_chpwd_active > 0)); then
    return
  fi

  # check if directory has changed
  if [[ "${PWD}" == "${__dot_chpwd_last_pwd}" ]]; then
    return
  fi
  __dot_chpwd_active=1
  __dot_chpwd_last_pwd="${PWD}"

  # if declared in function format
  if command -v chpwd &>/dev/null; then
    { chpwd; }
  fi
  # shellcheck disable=SC2125
  for hook in "${chpwd_functions[@]}"; do
    { "${hook}"; }
  done

  __dot_chpwd_active=0
}

# check on each prompt command
internal::prompt-action-push internal::chpwd-hook
