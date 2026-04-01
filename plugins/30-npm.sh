# shellcheck shell=bash
# Configure npm completion and defaults.
# SPDX-License-Identifier: MIT

# @see https://www.npmjs.com/
if ! command -v npm &>/dev/null; then
  return
fi

internal::cached-completion npm "npm completion bash"

# global node_modules without sudo
# @see https://github.com/sindresorhus/guides/blob/master/npm-global-without-sudo.md
NPM_PACKAGES="${HOME}/.npm-packages"
if ! command -v nvm &>/dev/null; then
  # https://docs.npmjs.com/cli/v8/commands/npm#directories
  export NPM_CONFIG_PREFIX="${HOME}/.npm-packages"
  internal::path-push "$NPM_PACKAGES/bin"
fi

if [[ -d "$NPM_PACKAGES/share/man" ]]; then
  MANPATH="${MANPATH:+${MANPATH}:}$NPM_PACKAGES/share/man"
  export MANPATH
fi

# Remove ad spam from npm install...
export OPEN_SOURCE_CONTRIBUTOR="true"
# optionally also works
# export ADBLOCK=1

# To force color in node scripts locally, set `export FORCE_COLOR=3` in
# `~/.bash_local` or `~/.bash_local.d/*.sh`. See README.md: `~/.bash_local`.
# https://nodejs.org/api/cli.html#force_color1-2-3
# export FORCE_COLOR=3
