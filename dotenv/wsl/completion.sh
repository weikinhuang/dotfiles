# shellcheck shell=bash
# Load WSL-specific shell completions.
# SPDX-License-Identifier: MIT

# Source per-command completions for scripts in dotenv/wsl/bin/.
for __dot_completion_file in "${DOTFILES__ROOT}/.dotfiles/dotenv/wsl/completion"/*.bash; do
  [[ -f "${__dot_completion_file}" ]] || continue
  # shellcheck source=/dev/null
  source "${__dot_completion_file}"
done
unset __dot_completion_file
