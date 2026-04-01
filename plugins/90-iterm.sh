# shellcheck shell=bash
# Configure iTerm shell integration.
# SPDX-License-Identifier: MIT

# @see https://iterm2.com/
if [[ "${DOTENV}" != darwin ]] || [[ -z "${ITERM_SESSION_ID:-}" ]]; then
  return
fi

# load iterm shell integration
if [[ -e /Applications/iTerm.app/Contents/Resources/iterm2_shell_integration.bash ]]; then
  function internal::iterm-load-integration() {
    # shellcheck source=/dev/null
    source /Applications/iTerm.app/Contents/Resources/iterm2_shell_integration.bash
    unset -f internal::iterm-load-integration
  }
  dotfiles_complete_functions+=(internal::iterm-load-integration)
fi
