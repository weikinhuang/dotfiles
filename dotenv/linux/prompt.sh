# shellcheck shell=bash
# Define Linux-specific prompt helpers.
# SPDX-License-Identifier: MIT

# function to get cpu load
if [[ -r /proc/loadavg ]]; then
  function internal::ps1-proc-use() {
    local loadavg
    read -r loadavg </proc/loadavg
    echo -n "${loadavg%% *}"
  }
else
  function internal::ps1-proc-use() {
    echo -n "$(uptime | awk '{print $(NF-2)}' | tr -d ',')"
  }
fi
