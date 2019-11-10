# shellcheck shell=bash
# include the system path for easy access to tools, it is already included in the 2018 fall creator's update
if echo "${PATH}" | grep -vq "$(wslpath -u c:/Windows/System32)"; then
  PATH="${PATH}:$(wslpath -u c:/Windows/System32)"
fi
