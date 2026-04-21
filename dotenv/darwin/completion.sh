# shellcheck shell=bash
# Load macOS-specific shell completions.
# SPDX-License-Identifier: MIT

# Source per-command completions for scripts in dotenv/darwin/bin/.
for __dot_completion_file in "${DOTFILES__ROOT}/.dotfiles/dotenv/darwin/completion"/*.bash; do
  [[ -f "${__dot_completion_file}" ]] || continue
  # shellcheck source=/dev/null
  source "${__dot_completion_file}"
done
unset __dot_completion_file
