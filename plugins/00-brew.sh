# shellcheck shell=bash
# Configure Homebrew Bash and GNU tool integration on macOS.
# SPDX-License-Identifier: MIT

# brew install bash binutils coreutils diffutils findutils gnu-sed gnutls moreutils grep less
# brew install jq

# Install newer Bash via Homebrew.
# Note: don’t forget to add the Homebrew bash to `/etc/shells` before continuing

# remove brew installed g prefix
if [[ "${DOTENV}" != "darwin" ]]; then
  unset DOT_INCLUDE_BREW_PATH
  return
fi

# derive prefix from brew binary location (avoids ~300ms `brew --prefix` Ruby boot)
__dot_brew_bin="$(PATH="/opt/homebrew/bin:${PATH}" command -v brew 2>/dev/null)"
if [[ -z "${__dot_brew_bin}" ]]; then
  unset DOT_INCLUDE_BREW_PATH __dot_brew_bin
  return
fi
__dot_brew_prefix="${__dot_brew_bin%/bin/brew}"
unset __dot_brew_bin

# automate including brew path
if [[ -n "${DOT_INCLUDE_BREW_PATH:-}" ]]; then
  internal::path-push --prepend "${__dot_brew_prefix}/opt"
  internal::path-push --prepend "${__dot_brew_prefix}/sbin"
  internal::path-push --prepend "${__dot_brew_prefix}/bin"

  # Cache gnubin/gnuman scans and refresh when Cellar metadata changes.
  __dot_brew_cellar_dir="${__dot_brew_prefix}/Cellar"
  __dot_brew_cache_key="${__dot_brew_prefix//\//_}"
  __dot_brew_gnu_cache_file="${DOTFILES__CONFIG_DIR}/cache/brew_gnu_paths.${__dot_brew_cache_key}.cache"
  # shellcheck disable=SC2329  # Invoked indirectly via internal::cache-write-atomic.
  internal::brew-gnu-cache-generate() {
    local p

    for p in "${__dot_brew_prefix}"/Cellar/*/*/libexec/gnubin; do
      [[ -d "${p}" ]] && printf 'PATH:%s\n' "${p}"
    done
    for p in "${__dot_brew_prefix}"/Cellar/*/*/libexec/gnuman; do
      [[ -d "${p}" ]] && printf 'MAN:%s\n' "${p}"
    done
  }
  if [[ ! -f "${__dot_brew_gnu_cache_file}" ]] \
    || { [[ -d "${__dot_brew_cellar_dir}" ]] && [[ "${__dot_brew_cellar_dir}" -nt "${__dot_brew_gnu_cache_file}" ]]; }; then
    internal::cache-write-atomic "${__dot_brew_gnu_cache_file}" "internal::brew-gnu-cache-generate"
  fi

  export MANPATH="${MANPATH:-/usr/share/man}"
  if [[ -d "${__dot_brew_prefix}/share/man" ]]; then
    MANPATH="${__dot_brew_prefix}/share/man:${MANPATH}"
  fi
  if [[ -s "${__dot_brew_gnu_cache_file}" ]]; then
    while IFS= read -r p; do
      case "${p}" in
        PATH:*)
          internal::path-push --prepend "${p#PATH:}"
          ;;
        MAN:*)
          MANPATH="${p#MAN:}:${MANPATH}"
          ;;
      esac
    done <"${__dot_brew_gnu_cache_file}"
  fi
  unset -f internal::brew-gnu-cache-generate
  unset p __dot_brew_cellar_dir __dot_brew_cache_key __dot_brew_gnu_cache_file
  export MANPATH
fi
unset DOT_INCLUDE_BREW_PATH

# Completion options
if [[ -f "${__dot_brew_prefix}/share/bash-completion/bash_completion" ]]; then
  # shellcheck source=/dev/null
  source "${__dot_brew_prefix}/share/bash-completion/bash_completion"
elif [[ -f "${__dot_brew_prefix}/etc/bash_completion" ]]; then
  # shellcheck source=/dev/null
  source "${__dot_brew_prefix}/etc/bash_completion"
fi

unset __dot_brew_prefix
