# shellcheck shell=bash
# Source the user's .bashrc from login shells.
# SPDX-License-Identifier: MIT

# source the users bashrc if it exists
if [[ -f "${HOME}/.bashrc" ]]; then
  # shellcheck source=/dev/null
  source "${HOME}/.bashrc"
fi
