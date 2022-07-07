# shellcheck shell=bash

# @see https://iterm2.com/
if [[ "${DOTENV}" != darwin ]] || [[ -z "${ITERM_SESSION_ID:-}" ]]; then
  return
fi

# load iterm shell integration
if [[ -e /Applications/iTerm.app/Contents/Resources/iterm2_shell_integration.bash ]]; then
  function __load_iterm_integration() {
    # shellcheck source=/dev/null
    source /Applications/iTerm.app/Contents/Resources/iterm2_shell_integration.bash
    unset -f __load_iterm_integration
  }
  dotfiles_complete_functions+=(__load_iterm_integration)
fi
