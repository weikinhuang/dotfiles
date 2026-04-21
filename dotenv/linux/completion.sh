# shellcheck shell=bash
# Load Linux-specific shell completions.
# SPDX-License-Identifier: MIT

# Completion options
if [[ -f /etc/bash_completion ]]; then
  # shellcheck source=/dev/null
  source /etc/bash_completion
fi

# Source per-command completions for scripts in dotenv/linux/bin/.
for __dot_completion_file in "${DOTFILES__ROOT}/.dotfiles/dotenv/linux/completion"/*.bash; do
  [[ -f "${__dot_completion_file}" ]] || continue
  # shellcheck source=/dev/null
  source "${__dot_completion_file}"
done
unset __dot_completion_file
