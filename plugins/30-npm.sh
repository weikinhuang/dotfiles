# shellcheck shell=bash

# @see https://www.npmjs.com/
if ! command -v npm &>/dev/null; then
  return
fi

# If the completion file does not exist, generate it and then source it
# Otherwise, source it and regenerate in the background
if [[ ! -f "${DOTFILES__CONFIG_DIR}/cache/completions/npm.bash" ]]; then
  npm completion bash 2>/dev/null | tee "${DOTFILES__CONFIG_DIR}/cache/completions/npm.bash" >/dev/null
  # shellcheck source=/dev/null
  source "${DOTFILES__CONFIG_DIR}/cache/completions/npm.bash"
else
  # shellcheck source=/dev/null
  source "${DOTFILES__CONFIG_DIR}/cache/completions/npm.bash"
  (npm completion bash 2>/dev/null | tee "${DOTFILES__CONFIG_DIR}/cache/completions/npm.bash" >/dev/null) &
fi

# global node_modules without sudo
# @see https://github.com/sindresorhus/guides/blob/master/npm-global-without-sudo.md
NPM_PACKAGES="${HOME}/.npm-packages"
if ! command -v nvm &>/dev/null; then
  # https://docs.npmjs.com/cli/v8/commands/npm#directories
  export NPM_CONFIG_PREFIX="${HOME}/.npm-packages"
  __push_path "$NPM_PACKAGES/bin"
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
