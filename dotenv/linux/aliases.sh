# shellcheck shell=bash
# Define Linux-specific aliases.
# SPDX-License-Identifier: MIT

# Networking shortcuts
function ips() {
  ip addr | grep 'inet\>' | perl -nle'/(\d+\.\d+\.\d+\.\d+)/ && print $1'
}
