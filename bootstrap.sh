#!/usr/bin/env bash
# Install and symlink the dotfiles into the target home directory.
# SPDX-License-Identifier: MIT

set -euo pipefail
IFS=$'\n\t'

# variables
readonly CONFIG_FILE="${HOME}/.config/dotfiles/.install"
readonly REPO_BASE="${REPO_BASE:-https://github.com/weikinhuang/dotfiles}"
DOTFILES__INSTALL_ROOT="${DOTFILES__INSTALL_ROOT:-${HOME}}"
LINKED_FILES=(
  "bash_profile.sh .bash_profile"
  "bashrc.sh .bashrc"
  "curlrc .curlrc"
  "hushlogin .hushlogin"
  "inputrc .inputrc"
  "mongoshrc.js .mongoshrc.js"
  "screenrc .screenrc"
  "tmux.conf .tmux.conf"
  "wgetrc .wgetrc"
)
DOTFILES__INSTALL_VIMRC=1
DOTFILES__INSTALL_GITCONFIG=1

# pull info from previous installation
if [[ -e "${CONFIG_FILE}" ]]; then
  # shellcheck source=/dev/null
  source "${CONFIG_FILE}"
fi

# link up gitconfig and vim if specified
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-git)
      DOTFILES__INSTALL_GITCONFIG=
      ;;
    --no-vim)
      DOTFILES__INSTALL_VIMRC=
      ;;
    --dir | -d)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for $1" >&2
        exit 1
      fi
      DOTFILES__INSTALL_ROOT="$2"
      shift
      ;;
  esac
  shift
done

# clean up
if [[ "${DOTFILES__INSTALL_VIMRC}" -eq 1 ]]; then
  LINKED_FILES+=("vimrc .vimrc")
fi
if [[ "${DOTFILES__INSTALL_GITCONFIG}" -eq 1 ]]; then
  LINKED_FILES+=("gitconfig .gitconfig")
fi

# root directory to install into
readonly DOTFILES_ROOT="${DOTFILES__INSTALL_ROOT}/.dotfiles"

# store the configuration of for future reference
mkdir -p "$(dirname "${CONFIG_FILE}")"
echo "DOTFILES__INSTALL_ROOT=\"${DOTFILES__INSTALL_ROOT}\"" >|"${CONFIG_FILE}"
echo "DOTFILES__INSTALL_VIMRC=${DOTFILES__INSTALL_VIMRC}" >>"${CONFIG_FILE}"
echo "DOTFILES__INSTALL_GITCONFIG=${DOTFILES__INSTALL_GITCONFIG}" >>"${CONFIG_FILE}"

# link up files
function dotfiles::install::link() {
  local file target
  IFS=' ' read -r file target <<<"${1}"

  # remove the backup first
  [[ -e "${DOTFILES__INSTALL_ROOT}/${target}.bak" ]] && rm -f "${DOTFILES__INSTALL_ROOT}/${target}.bak"

  # create the backup file if not symlink
  [[ -e "${DOTFILES__INSTALL_ROOT}/${target}" && ! -L "${DOTFILES__INSTALL_ROOT}/${target}" ]] \
    && mv "${DOTFILES__INSTALL_ROOT}/${target}" "${DOTFILES__INSTALL_ROOT}/${target}.bak"

  # link up the file
  if [[ -e "${DOTFILES_ROOT}/${file}" ]]; then
    echo "linking up '${DOTFILES_ROOT}/${file}' => '${DOTFILES__INSTALL_ROOT}/${target}'"
    if ! ln -sf "${DOTFILES_ROOT}/${file}" "${DOTFILES__INSTALL_ROOT}/${target}"; then
      echo "Unable to symlink '${DOTFILES__INSTALL_ROOT}/${target}'"
    fi
  fi
}

function dotfiles::install::remove_managed_legacy_link() {
  local target expected_target current_target
  target="${DOTFILES__INSTALL_ROOT}/$1"
  expected_target="${DOTFILES_ROOT}/$2"

  if [[ ! -L "${target}" ]]; then
    return 0
  fi

  current_target="$(readlink "${target}")"
  if [[ "${current_target}" == "${expected_target}" ]]; then
    rm -f "${target}"
  fi
}

# abstract updating from git or curl
function dotfiles::install::repo::get::git() {
  local GITHUB_URL="${1}"
  local DIR="${2}"
  git clone "${GITHUB_URL}" "${DIR}"
}

function dotfiles::install::repo::get::curl() {
  local GITHUB_URL="${1}"
  local DIR="${2}"
  mkdir -p "${DIR}"
  curl -#L "${GITHUB_URL}/tarball/master" | tar -C "${DIR}" -xzv --strip-components 1
}

function dotfiles::install::repo::get() {
  local GITHUB_URL="${1}"
  local DIR="${2}"
  # sanity check, git is now required for auto install
  if command -v git &>/dev/null; then
    dotfiles::install::repo::get::git "${GITHUB_URL}" "${DIR}"
  else
    dotfiles::install::repo::get::curl "${GITHUB_URL}" "${DIR}"
  fi
}

function dotfiles::install::repo::update::git() {
  local DIR="${1}"
  # check if there are git changes
  if git -C "${DIR}" diff-index --quiet HEAD -- &>/dev/null; then
    # no changes
    git -C "${DIR}" pull origin master || return 1
  else
    # changes
    git -C "${DIR}" stash || true
    git -C "${DIR}" pull origin master || return 1
    git -C "${DIR}" stash pop || true
  fi
}

function dotfiles::install::vim() {
  local VIM_BIN

  # check if install vim configs is set
  if [[ -z "${DOTFILES__INSTALL_VIMRC:-}" ]]; then
    return 0
  fi

  # create vim config dir
  mkdir -p "${DOTFILES__INSTALL_ROOT}/.vim"
  mkdir -p "${DOTFILES__INSTALL_ROOT}/.config/nvim"

  dotfiles::install::link "config/vim/nvim-init.lua .config/nvim/init.lua"

  if command -v nvim &>/dev/null; then
    VIM_BIN="nvim"
  elif command -v vim &>/dev/null; then
    VIM_BIN="vim"
  else
    VIM_BIN=
  fi

  if [[ "${VIM_BIN}" == "nvim" ]]; then
    local nvim_ver
    nvim_ver="$("${VIM_BIN}" --version | head -1)"
    if [[ "${nvim_ver}" =~ v([0-9]+)\.([0-9]+) ]] && ((BASH_REMATCH[1] > 0 || BASH_REMATCH[2] >= 10)); then
      echo "Installing Neovim plugins (lazy.nvim)"
      echo "${VIM_BIN}" --headless "+Lazy! sync" +qa
      if ! "${VIM_BIN}" --headless "+Lazy! sync" +qa; then
        echo "--------------- Please Run: 'nvim --headless \"+Lazy! sync\" +qa' after installation"
      fi
    else
      echo "Installing Neovim plugins (vim-plug, nvim < 0.10)"
      echo "${VIM_BIN}" --headless -c 'PlugInstall --sync' -c qa
      if ! "${VIM_BIN}" --headless -c 'PlugInstall --sync' -c qa; then
        echo "--------------- Please Run: 'nvim -c \"PlugInstall --sync\" -c qa' after installation"
      fi
    fi
  elif [[ "${VIM_BIN}" == "vim" ]]; then
    echo "Installing Vim plugins"
    if [[ ! -f "${DOTFILES__INSTALL_ROOT}/.vim/autoload/plug.vim" ]]; then
      echo "Downloading vim-plug..."
      curl -fLo "${DOTFILES__INSTALL_ROOT}/.vim/autoload/plug.vim" --create-dirs \
        https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim || true
    fi
    echo "${VIM_BIN}" -u "${DOTFILES_ROOT}/vimrc" -c 'PlugInstall --sync' -c qa
    if ! "${VIM_BIN}" -u "${DOTFILES_ROOT}/vimrc" -c 'PlugInstall --sync' -c qa; then
      echo "--------------- Please Run: 'vim +PlugInstall +qall' after installation"
    fi
  else
    echo "--------------- Please Run: 'nvim --headless \"+Lazy! sync\" +qa' after installing Neovim"
    echo "--------------- Please Run: 'vim +PlugInstall +qall' after installing Vim"
  fi

  dotfiles::install::link "config/vim/ftplugin .vim/ftplugin"
  dotfiles::install::remove_managed_legacy_link ".vim/coc-settings.json" "config/vim/coc-settings.json"
  dotfiles::install::remove_managed_legacy_link ".config/nvim/coc-settings.json" "config/vim/coc-settings.json"
}

function dotfiles::install::repo::update() {
  local GITHUB_URL="${1}"
  local DIR="${2}"
  # sanity check, git is now required for auto install
  if command -v git &>/dev/null; then
    dotfiles::install::repo::update::git "${DIR}"
  else
    dotfiles::install::repo::get::curl "${GITHUB_URL}" "${DIR}"
  fi
}

# this is a fresh install
function dotfiles::install::install() {
  # attempt to make the dotfiles directory
  mkdir -p "${DOTFILES_ROOT}" || return 1

  # download the latest version
  dotfiles::install::repo::get "${REPO_BASE}" "${DOTFILES_ROOT}"

  # Install vim configs
  dotfiles::install::vim
}

# update the dotfiles
function dotfiles::install::update() {
  # update to the latest version
  dotfiles::install::repo::update "${REPO_BASE}" "${DOTFILES_ROOT}"

  # Install vim configs
  dotfiles::install::vim
}

# make the dotfiles directory
if [[ ! -d "${DOTFILES_ROOT}" ]]; then
  # we don't have anything
  DOTFILES_EXEC=dotfiles::install::install
else
  # just update
  DOTFILES_EXEC=dotfiles::install::update
fi

# try to install or update the files
if ! ${DOTFILES_EXEC}; then
  echo "there has been an issue installing dotfiles, please install manually"
  exit 1
fi

# symlink all the files
for file in "${LINKED_FILES[@]}"; do
  dotfiles::install::link "${file}"
done
dotfiles::install::remove_managed_legacy_link ".mongorc.js" "mongorc.js"

# done
echo
echo -e "\033[1mDotfiles has been installed/updated, please reload your session.\033[0m"
