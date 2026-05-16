# shellcheck shell=bash
# Configure nvm lazy loading and PATH setup.
# SPDX-License-Identifier: MIT

# setup nvm base dir - prefer XDG location, fall back to ~/.nvm
if [[ -n "${XDG_CONFIG_HOME-}" ]] && [[ -s "${XDG_CONFIG_HOME}/nvm/nvm.sh" ]]; then
  NVM_DIR="${XDG_CONFIG_HOME}/nvm"
elif [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
  NVM_DIR="${HOME}/.nvm"
elif [[ -n "${XDG_CONFIG_HOME-}" ]]; then
  NVM_DIR="${XDG_CONFIG_HOME}/nvm"
else
  NVM_DIR="${HOME}/.nvm"
fi

# @see https://github.com/nvm-sh/nvm
if ! command -v nvm &>/dev/null && [[ ! -s "${NVM_DIR}/nvm.sh" ]]; then
  # clean up if we're not using nvm
  unset NVM_DIR
  return
fi

# unset NPM_PREFIX
unset NPM_CONFIG_PREFIX

# shellcheck disable=SC2155
export NVM_DIR

# ---------------------------------------------------------------------------
# Lazy loading: defer sourcing nvm.sh (~200-500ms) until first use.
# The default node version's bin dir is cached so node/npm/npx are on PATH
# immediately without loading nvm.
# ---------------------------------------------------------------------------

# Values passed to internal::cache-write-atomic run through eval, so emit the
# target path from a function instead of baking expanded vars into a command
# string.  __dot_nvm_cache_target is set before each call.
__dot_nvm_cache_target=
# shellcheck disable=SC2329  # Invoked indirectly via internal::cache-write-atomic.
internal::nvm-cache-emit-default-path() {
  printf '%s' "${__dot_nvm_cache_target}"
}

__dot_nvm_cache_file="${DOTFILES__CONFIG_DIR}/cache/nvm_default_path"
if [[ -s "${__dot_nvm_cache_file}" ]]; then
  __dot_nvm_cached_path=
  IFS= read -r __dot_nvm_cached_path <"${__dot_nvm_cache_file}" || [[ -n "${__dot_nvm_cached_path}" ]]
  if [[ -d "${__dot_nvm_cached_path}" ]]; then
    internal::path-push --prepend "${__dot_nvm_cached_path}"
  fi
  unset __dot_nvm_cached_path
else
  # No cache yet: source nvm eagerly this one time to seed it
  if ! command -v nvm &>/dev/null && [[ -s "${NVM_DIR}/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    source "${NVM_DIR}/nvm.sh"
    # shellcheck source=/dev/null
    [[ -s "${NVM_DIR}/bash_completion" ]] && source "${NVM_DIR}/bash_completion"
  fi
  __dot_nvm_default_path_version="$(nvm version default 2>/dev/null)"
  if [[ -n "${__dot_nvm_default_path_version}" ]] && [[ "${__dot_nvm_default_path_version}" != "N/A" ]]; then
    __dot_nvm_cache_target="${NVM_DIR}/versions/node/${__dot_nvm_default_path_version}/bin"
    internal::path-push --prepend "${__dot_nvm_cache_target}"
    internal::cache-write-atomic "${__dot_nvm_cache_file}" internal::nvm-cache-emit-default-path
  fi
  unset __dot_nvm_default_path_version
fi
unset __dot_nvm_cache_file

internal::nvm-lazy-load() {
  unset -f nvm node npm npx internal::nvm-lazy-load
  # shellcheck source=/dev/null
  [[ -s "${NVM_DIR}/nvm.sh" ]] && source "${NVM_DIR}/nvm.sh"
  # shellcheck source=/dev/null
  [[ -s "${NVM_DIR}/bash_completion" ]] && source "${NVM_DIR}/bash_completion"
  # refresh cached default for next startup
  local ver
  ver="$(nvm version default 2>/dev/null)"
  if [[ -n "$ver" ]] && [[ "$ver" != "N/A" ]]; then
    __dot_nvm_cache_target="${NVM_DIR}/versions/node/${ver}/bin"
    internal::cache-write-atomic \
      "${DOTFILES__CONFIG_DIR}/cache/nvm_default_path" \
      internal::nvm-cache-emit-default-path
  fi
}

if ! command -v nvm &>/dev/null; then
  nvm() {
    internal::nvm-lazy-load
    nvm "$@"
  }
  node() {
    internal::nvm-lazy-load
    node "$@"
  }
  npm() {
    internal::nvm-lazy-load
    npm "$@"
  }
  npx() {
    internal::nvm-lazy-load
    npx "$@"
  }
fi

# automatically load nvm as needed
# https://github.com/nvm-sh/nvm#automatically-call-nvm-use
__dot_nvm_last_scope=
__dot_nvm_last_resolved=
__dot_nvm_default_version=

internal::nvm-current-version() {
  if [[ -n "${NVM_BIN:-}" ]]; then
    local current_path="${NVM_BIN%/bin}"
    echo "${current_path##*/}"
    return
  fi
  echo ""
}

internal::nvm-resolve-default-version() {
  if [[ -n "${__dot_nvm_default_version:-}" ]] && [[ "${__dot_nvm_default_version}" != "N/A" ]]; then
    echo "${__dot_nvm_default_version}"
    return
  fi

  __dot_nvm_default_version="$(nvm version default 2>/dev/null || true)"
  if [[ "${__dot_nvm_default_version}" == "N/A" ]]; then
    nvm alias default node >/dev/null 2>&1 || true
    __dot_nvm_default_version="$(nvm version default 2>/dev/null || true)"
  fi
  echo "${__dot_nvm_default_version}"
}

cdnvm() {
  local nvm_path nvmrc_path nvm_version scope current_version resolved_version default_version

  if ! command -v nvm_find_up &>/dev/null; then
    internal::nvm-lazy-load 2>/dev/null || true
  fi

  nvm_path="$(nvm_find_up .nvmrc | tr -d '\n')"

  # If there are no .nvmrc file, use the default nvm version
  if [[ ! "${nvm_path}" = *[^[:space:]]* ]]; then
    scope="__default__"
    current_version="$(internal::nvm-current-version)"
    default_version="$(internal::nvm-resolve-default-version)"

    if [[ "${__dot_nvm_last_scope}" == "${scope}" ]] && [[ "${current_version}" == "${default_version}" ]]; then
      return
    fi

    if [[ -n "${default_version}" ]] && [[ "${current_version}" != "${default_version}" ]]; then
      nvm use default >/dev/null
    fi
    __dot_nvm_last_scope="${scope}"
    __dot_nvm_last_resolved="${default_version}"
    return
  fi

  nvmrc_path="${nvm_path}/.nvmrc"
  if [[ -s "${nvmrc_path}" ]] && [[ -r "${nvmrc_path}" ]]; then
    nvm_version="$(<"${nvmrc_path}")"
    scope="${nvm_path}:${nvm_version}"
    current_version="$(internal::nvm-current-version)"

    if [[ "${__dot_nvm_last_scope}" == "${scope}" ]] && [[ "${current_version}" == "${__dot_nvm_last_resolved}" ]]; then
      return
    fi

    # `nvm version` resolves to an installed concrete version or N/A.
    resolved_version="$(nvm version "${nvm_version}" 2>/dev/null || true)"
    if [[ "${resolved_version}" == "N/A" ]]; then
      nvm install "${nvm_version}"
      resolved_version="$(nvm version "${nvm_version}" 2>/dev/null || true)"
    elif [[ "${current_version}" != "${resolved_version}" ]]; then
      nvm use "${nvm_version}" >/dev/null
    fi

    __dot_nvm_last_scope="${scope}"
    __dot_nvm_last_resolved="${resolved_version}"
  fi
}
internal::array-append-unique chpwd_functions cdnvm

# manual upgrade function
# https://github.com/nvm-sh/nvm#manual-upgrade
function nvm-upgrade() {
  (
    # shellcheck disable=SC2164
    cd "$NVM_DIR"
    git fetch --tags origin
    git checkout "$(git describe --abbrev=0 --tags --match "v[0-9]*" "$(git rev-list --tags --max-count=1)")"
  )
}
