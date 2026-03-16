# shellcheck shell=bash
# Configure npm completion and defaults.
# SPDX-License-Identifier: MIT

# @see https://www.npmjs.com/
if ! command -v npm &>/dev/null; then
  return
fi

__dot_cached_completion npm "npm completion bash"

# global node_modules without sudo
# @see https://github.com/sindresorhus/guides/blob/master/npm-global-without-sudo.md
NPM_PACKAGES="${HOME}/.npm-packages"
if ! command -v nvm &>/dev/null; then
  # https://docs.npmjs.com/cli/v8/commands/npm#directories
  export NPM_CONFIG_PREFIX="${HOME}/.npm-packages"
  __push_path "$NPM_PACKAGES/bin"
fi

if [[ -d "$NPM_PACKAGES/share/man" ]]; then
  MANPATH="${MANPATH:+${MANPATH}:}$NPM_PACKAGES/share/man"
  export MANPATH
fi

# Remove ad spam from npm install...
export OPEN_SOURCE_CONTRIBUTOR="true"
# optionally also works
# export ADBLOCK=1

# force colors in node scripts
# https://nodejs.org/api/cli.html#force_color1-2-3
export FORCE_COLOR=3
