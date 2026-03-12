# shellcheck shell=bash
# Define macOS-specific aliases.
# SPDX-License-Identifier: MIT

# Shortcuts

# Networking shortcuts
function ips() {
  ifconfig | grep 'inet\>' | perl -nle'/(\d+\.\d+\.\d+\.\d+)/ && print $1'
}
