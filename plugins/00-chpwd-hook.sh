# shellcheck shell=bash

# Avoid duplicate inclusion
if [[ -n "${bash_chpwd_imported:-}" ]]; then
    return
fi
bash_chpwd_imported="defined"

if ! declare -p chpwd_functions &>/dev/null; then
  # shellcheck disable=SC2034
  declare -a chpwd_functions
fi

__dot_inside_chpwd=0
__dot_inside_chpwd_last=
# execute dotfile load hooks
function __dot_chpwd_hook() {
  local hook

  # Don't invoke chpwd if we are inside of another chpwd.
  if (( __dot_inside_chpwd > 0 )); then
    return
  fi
  local __dot_inside_chpwd=1

  # check if directory has changed
  if [[ "${PWD}" == "${__dot_inside_chpwd_last}" ]]; then
    return
  fi
  __dot_inside_chpwd_last="${PWD}"

  # if declared in function format
  if type chpwd &>/dev/null; then
    { chpwd; }
  fi
  # shellcheck disable=SC2125
  for hook in "${chpwd_functions[@]}"; do
    { "${hook}"; }
  done
}

# check on each prompt command
__push_internal_prompt_command __dot_chpwd_hook
