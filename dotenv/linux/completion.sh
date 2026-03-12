# shellcheck shell=bash
# Load Linux-specific shell completions.
# SPDX-License-Identifier: MIT

# Completion options
if [[ -f /etc/bash_completion ]]; then
  # shellcheck source=/dev/null
  source /etc/bash_completion
fi
