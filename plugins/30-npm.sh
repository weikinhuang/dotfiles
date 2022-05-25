# shellcheck shell=bash

# @see https://www.npmjs.com/
if command -v npm &>/dev/null; then
  # autocomplete for npm
  # shellcheck source=/dev/null
  source <(npm completion bash 2>/dev/null)

  # global node_modules without sudo
  # @see https://github.com/sindresorhus/guides/blob/master/npm-global-without-sudo.md
  NPM_PACKAGES="${HOME}/.npm-packages"
  if ! command -v nvm &>/dev/null; then
    # https://docs.npmjs.com/cli/v8/commands/npm#directories
    export NPM_CONFIG_PREFIX="${HOME}/.npm-packages"
    export PATH="$PATH:$NPM_PACKAGES/bin"
  fi

  # shellcheck disable=SC2155
  export MANPATH="$(manpath 2>/dev/null):$NPM_PACKAGES/share/man" || true

  # Remove ad spam from npm install...
  export OPEN_SOURCE_CONTRIBUTOR="true"
  # optionally also works
  # export ADBLOCK=1

  # force colors in node scripts
  # https://nodejs.org/api/cli.html#force_color1-2-3
  export FORCE_COLOR=3
fi
