# shellcheck shell=bash
# Define macOS-specific prompt helpers.
# SPDX-License-Identifier: MIT

# function to get cpu load
function internal::ps1-proc-use() {
  local raw
  raw="$(/usr/sbin/sysctl -n vm.loadavg)"
  raw="${raw#\{ }"
  echo -n "${raw%% *}"
}
