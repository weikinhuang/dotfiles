# shellcheck shell=bash

# include the system path for easy access to tools, it is already included in the 2018 fall creator's update
if ! (echo "${PATH}" | tr ':' '\n' | grep -qi "^$(wslpath -u c:/Windows/System32)$"); then
  __push_path "$(wslpath -u c:/Windows/system32)"
fi
__push_path "$(wslpath -u c:/Windows)"
__push_path "$(wslpath -u c:/Windows/System32/Wbem)"
__push_path "$(wslpath -u c:/Windows/System32/WindowsPowerShell/v1.0/)"

# set default browser to native behavior
export BROWSER=winstart
