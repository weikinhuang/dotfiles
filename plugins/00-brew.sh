# shellcheck shell=bash
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
_brew_bin="$(env PATH="/opt/homebrew/bin:${PATH}" command -v brew 2>/dev/null)"
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

  # Build PATH variable for brew gnu utils
  for p in "${__BREW_PREFIX}"/Cellar/*/*/libexec/gnubin; do
    __push_path --prepend "${p}"
  done
  unset p

  export MANPATH="${MANPATH:-/usr/share/man}"
  if [[ -d "${__BREW_PREFIX}/share/man" ]]; then
    MANPATH="${__BREW_PREFIX}/share/man:${MANPATH}"
  fi
  # update man path for brew gnu utils
  for p in "${__BREW_PREFIX}"/Cellar/*/*/libexec/gnuman; do
    MANPATH="${p}:${MANPATH}"
  done
  unset p
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
