# shellcheck shell=bash
# include the system path for easy access to tools, it is already included in the 2018 fall creator's update
if echo "${PATH}" | tr ':' '\n' | grep -vq "^$(wslpath -u c:/Windows/System32)$"; then
  PATH="${PATH}:$(wslpath -u c:/Windows/System32)"
fi
if echo "${PATH}" | tr ':' '\n' | grep -vq "^$(wslpath -u c:/Windows)$"; then
  PATH="${PATH}:$(wslpath -u c:/Windows)"
fi
if echo "${PATH}" | tr ':' '\n' | grep -vq "^$(wslpath -u c:/Windows/System32/Wbem)$"; then
  PATH="${PATH}:$(wslpath -u c:/Windows/System32/Wbem)"
fi
if echo "${PATH}" | tr ':' '\n' | grep -vq "^$(wslpath -u c:/Windows/System32/WindowsPowerShell/v1.0/)$"; then
  PATH="${PATH}:$(wslpath -u c:/Windows/System32/WindowsPowerShell/v1.0/)"
fi
