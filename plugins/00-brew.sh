# shellcheck shell=bash
# brew install bash binutils coreutils diffutils findutils gnu-sed gnutls moreutils grep less
# brew install jq

# Install Bash 4.
# Note: don’t forget to add `/usr/local/bin/bash` to `/etc/shells` before continuing

# remove brew installed g prefix
if [[ "${DOTENV}" != "darwin" ]] || ! command -v brew &>/dev/null || [[ -z "${DOT_INCLUDE_BREW_PATH:-}" ]]; then
  unset DOT_INCLUDE_BREW_PATH
  return
fi
unset DOT_INCLUDE_BREW_PATH

if [[ -d "$(brew --prefix)/opt" ]] && ! echo "${PATH}" | tr ':' '\n' | grep -q "^$(brew --prefix)/opt$"; then
  PATH="$(brew --prefix)/opt:${PATH}"
fi
if [[ -d "$(brew --prefix)/sbin" ]] && ! echo "${PATH}" | tr ':' '\n' | grep -q "^$(brew --prefix)/sbin$"; then
  PATH="$(brew --prefix)/sbin:${PATH}"
fi
if [[ -d "$(brew --prefix)/bin" ]] && ! echo "${PATH}" | tr ':' '\n' | grep -q "^$(brew --prefix)/bin$"; then
  PATH="$(brew --prefix)/bin:${PATH}"
fi

# Build PATH variable for brew gnu utils
for p in "$(brew --prefix)"/Cellar/*/*/libexec/gnubin; do
  PATH="${p}:${PATH}"
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
