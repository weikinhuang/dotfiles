# shellcheck shell=bash

# @see https://github.com/Wilfred/difftastic
if ! command -v difft &>/dev/null; then
  rm -f "${DOTFILES__CONFIG_DIR}/git-difftastic.gitconfig"
  return
fi

# Difftastic environment variable defaults
# Auto-detect background from solarized theme, fallback to dark
if [[ -z "${DFT_BACKGROUND+x}" ]]; then
  if [[ -n "${DOT_SOLARIZED_LIGHT:-}" ]]; then
    export DFT_BACKGROUND="light"
  else
    export DFT_BACKGROUND="dark"
  fi
fi
# Use side-by-side display
export DFT_DISPLAY="${DFT_DISPLAY:-side-by-side}"
# Match common tab width convention
export DFT_TAB_WIDTH="${DFT_TAB_WIDTH:-4}"
# Allow some parse errors before falling back to line-oriented diff
export DFT_PARSE_ERROR_LIMIT="${DFT_PARSE_ERROR_LIMIT:-3}"

# Generate a git include config for difftastic if not already present
if [[ ! -f "${DOTFILES__CONFIG_DIR}/git-difftastic.gitconfig" ]]; then
  cat > "${DOTFILES__CONFIG_DIR}/git-difftastic.gitconfig" << 'GITCONFIG'
[diff]
  tool = difftastic

[difftool "difftastic"]
  cmd = difft "$MERGED" "$LOCAL" "abcdef1" "100644" "$REMOTE" "abcdef2" "100644"

[pager]
  difftool = true
GITCONFIG
fi
