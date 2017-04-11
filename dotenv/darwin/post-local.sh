# brew install bash binutils coreutils diffutils findutils gnu-sed gnutls moreutils
# brew install homebrew/dupes/grep homebrew/dupes/less

# Install Bash 4.
# Note: don’t forget to add `/usr/local/bin/bash` to `/etc/shells` before

# remove brew installed g prefix
if [[ -n "${INCLUDE_BREW_PATH}" ]]; then
  [[ -d "/usr/local/sbin" ]] && PATH="/usr/local/sbin:${PATH}"

  # Build PATH variable for brew utils
  for p in /usr/local/Cellar/*/*/bin; do
    PATH="${p}:${PATH}"
  done
  for p in /usr/local/Cellar/*/*/libexec/gnubin; do
    PATH="${p}:${PATH}"
  done
  unset p

  # update man path for brew utils
  export MANPATH="${MANPATH-/usr/share/man}"
  for p in /usr/local/Cellar/*/*/share/man; do
    MANPATH="${p}:${MANPATH}"
  done
  for p in /usr/local/Cellar/*/*/libexec/gnuman; do
    MANPATH="${p}:${MANPATH}"
  done
  unset p
  export MANPATH

  unset INCLUDE_BREW_PATH
fi
