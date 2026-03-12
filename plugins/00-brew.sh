# shellcheck shell=bash
# Configure Homebrew Bash and GNU tool integration on macOS.
# SPDX-License-Identifier: MIT

# brew install bash binutils coreutils diffutils findutils gnu-sed gnutls moreutils grep less
# brew install jq

# Install Bash 4.
# Note: don’t forget to add `/usr/local/bin/bash` to `/etc/shells` before continuing

# remove brew installed g prefix
if [[ "${DOTENV}" != "darwin" ]]; then
  unset DOT_INCLUDE_BREW_PATH
  return
fi

# derive prefix from brew binary location (avoids ~300ms `brew --prefix` Ruby boot)
_brew_bin="$(PATH="/opt/homebrew/bin:${PATH}" command -v brew 2>/dev/null)"
if [[ -z "${_brew_bin}" ]]; then
  unset DOT_INCLUDE_BREW_PATH _brew_bin
  return
fi
__BREW_PREFIX="${_brew_bin%/bin/brew}"
unset _brew_bin

# automate including brew path
if [[ -n "${DOT_INCLUDE_BREW_PATH:-}" ]]; then
  __push_path --prepend "${__BREW_PREFIX}/opt"
  __push_path --prepend "${__BREW_PREFIX}/sbin"
  __push_path --prepend "${__BREW_PREFIX}/bin"

  # Cache gnubin/gnuman scans and refresh when Cellar metadata changes.
  __brew_cellar_dir="${__BREW_PREFIX}/Cellar"
  __brew_cache_key="${__BREW_PREFIX//\//_}"
  __brew_gnu_cache_file="${DOTFILES__CONFIG_DIR}/cache/brew_gnu_paths.${__brew_cache_key}.cache"
  if [[ ! -f "${__brew_gnu_cache_file}" ]] \
    || { [[ -d "${__brew_cellar_dir}" ]] && [[ "${__brew_cellar_dir}" -nt "${__brew_gnu_cache_file}" ]]; }; then
    __brew_gnu_tmp="${__brew_gnu_cache_file}.tmp.$$.$RANDOM"
    mkdir -p "${__brew_gnu_cache_file%/*}"
    {
      for p in "${__BREW_PREFIX}"/Cellar/*/*/libexec/gnubin; do
        [[ -d "${p}" ]] && printf 'PATH:%s\n' "${p}"
      done
      for p in "${__BREW_PREFIX}"/Cellar/*/*/libexec/gnuman; do
        [[ -d "${p}" ]] && printf 'MAN:%s\n' "${p}"
      done
    } >"${__brew_gnu_tmp}"
    mv -f "${__brew_gnu_tmp}" "${__brew_gnu_cache_file}"
    unset __brew_gnu_tmp
  fi

  export MANPATH="${MANPATH:-/usr/share/man}"
  if [[ -d "${__BREW_PREFIX}/share/man" ]]; then
    MANPATH="${__BREW_PREFIX}/share/man:${MANPATH}"
  fi
  if [[ -s "${__brew_gnu_cache_file}" ]]; then
    while IFS= read -r p; do
      case "${p}" in
        PATH:*)
          __push_path --prepend "${p#PATH:}"
          ;;
        MAN:*)
          MANPATH="${p#MAN:}:${MANPATH}"
          ;;
      esac
    done <"${__brew_gnu_cache_file}"
  fi
  unset p __brew_cellar_dir __brew_cache_key __brew_gnu_cache_file
  export MANPATH
fi
unset DOT_INCLUDE_BREW_PATH

# Completion options
if [[ -f "${__BREW_PREFIX}/share/bash-completion/bash_completion" ]]; then
  # shellcheck source=/dev/null
  source "${__BREW_PREFIX}/share/bash-completion/bash_completion"
elif [[ -f "${__BREW_PREFIX}/etc/bash_completion" ]]; then
  # shellcheck source=/dev/null
  source "${__BREW_PREFIX}/etc/bash_completion"
fi

unset __BREW_PREFIX
