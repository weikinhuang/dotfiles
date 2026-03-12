# shellcheck shell=bash
# Define macOS-specific prompt helpers.
# SPDX-License-Identifier: MIT

# function to get cpu load
function __ps1_proc_use() {
  local raw
  raw="$(/usr/sbin/sysctl -n vm.loadavg)"
  raw="${raw#\{ }"
  echo -n "${raw%% *}"
}
