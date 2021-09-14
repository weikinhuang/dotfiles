# shellcheck shell=bash
# source the users bashrc if it exists
if [[ -f "${HOME}/.bashrc" ]]; then
  # shellcheck source=bashrc.sh
  source "${HOME}/.bashrc"
fi
