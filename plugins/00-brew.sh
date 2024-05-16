# shellcheck shell=bash
# brew install bash binutils coreutils diffutils findutils gnu-sed gnutls moreutils grep less
# brew install jq

# Install Bash 4.
# Note: don’t forget to add `/usr/local/bin/bash` to `/etc/shells` before continuing

# remove brew installed g prefix
if [[ "${DOTENV}" != "darwin" ]] || ! command -v brew &>/dev/null; then
  unset DOT_INCLUDE_BREW_PATH
  return
fi

# automate including brew path
if [[ -n "${DOT_INCLUDE_BREW_PATH:-}" ]]; then
  __push_path --prepend "$(brew --prefix)/opt"
  __push_path --prepend "$(brew --prefix)/sbin"
  __push_path --prepend "$(brew --prefix)/bin"

  # Build PATH variable for brew gnu utils
  for p in "$(brew --prefix)"/Cellar/*/*/libexec/gnubin; do
    __push_path --prepend "${p}"
  done
  unset p

  export MANPATH="${MANPATH:-/usr/share/man}"
  if [[ -d "$(brew --prefix)/share/man" ]]; then
    MANPATH="$(brew --prefix)/share/man:${MANPATH}"
  fi
  # update man path for brew gnu utils
  for p in "$(brew --prefix)"/Cellar/*/*/libexec/gnuman; do
    MANPATH="${p}:${MANPATH}"
  done
  unset p
  export MANPATH
fi
unset DOT_INCLUDE_BREW_PATH

# Completion options
if [[ -f "$(brew --prefix)/share/bash-completion/bash_completion" ]]; then
  # shellcheck source=/dev/null
  source "$(brew --prefix)/share/bash-completion/bash_completion"
elif [[ -f "$(brew --prefix)/etc/bash_completion" ]]; then
  # shellcheck source=/dev/null
  source "$(brew --prefix)/etc/bash_completion"
fi
