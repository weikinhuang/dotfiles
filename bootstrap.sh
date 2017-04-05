#!/bin/bash

# Strict mode http://redsymbol.net/articles/unofficial-bash-strict-mode/
set -euo pipefail
IFS=$'\n\t'

# variables
readonly CONFIG_FILE="${HOME}/.config/dotfiles/.install"
readonly REPO_BASE="${REPO_BASE:-https://github.com/weikinhuang/dotfiles}"
DOTFILES__INSTALL_ROOT="${DOTFILES__INSTALL_ROOT:-${HOME}}"
LINKED_FILES=(
  "bash_profile.sh .bash_profile"
  "bashrc.sh .bashrc"
  "dotenv .dotenv"
  "hushlogin .hushlogin"
  "inputrc .inputrc"
  "mongorc.js .mongorc.js"
  "screenrc .screenrc"
  "wgetrc .wgetrc"
)
DOTFILES__INSTALL_VIMRC=1
DOTFILES__INSTALL_GITCONFIG=1

# pull info from previous installation
if [[ -e "${CONFIG_FILE}" ]]; then
  source "${CONFIG_FILE}"
fi

# link up gitconfig and vim if specified
if [[ -n $# ]]; then
  for arg in "$@"; do
    case "${arg}" in
      --no-git)
        DOTFILES__INSTALL_GITCONFIG=0
        ;;
      --no-vim)
        DOTFILES__INSTALL_VIMRC=0
        ;;
      --dir|-d)
        shift 1
        DOTFILES__INSTALL_ROOT="${1}"
        ;;
    esac
  done
fi

# clean up
if [[ "${DOTFILES__INSTALL_VIMRC}" -eq 1 ]]; then
  LINKED_FILES+=("vimrc .vimrc" "vim .vim")
fi
if [[ "${DOTFILES__INSTALL_GITCONFIG}" -eq 1  ]]; then
  LINKED_FILES+=("gitconfig .gitconfig")
fi

# root directory to install into
readonly DOTFILES_ROOT="${DOTFILES__INSTALL_ROOT}/.dotfiles"

# store the configuration of for future reference
mkdir -p "$(dirname "${CONFIG_FILE}")"
echo "DOTFILES__INSTALL_ROOT=\"${DOTFILES__INSTALL_ROOT}\"" > "${CONFIG_FILE}"
echo "DOTFILES__INSTALL_VIMRC=${DOTFILES__INSTALL_VIMRC}" >> "${CONFIG_FILE}"
echo "DOTFILES__INSTALL_GITCONFIG=${DOTFILES__INSTALL_GITCONFIG}" >> "${CONFIG_FILE}"

# link up files
function dotfiles::link () {
  local file="$(echo "${1}" | cut -d' ' -f1)"
  local target="$(echo "${1}" | cut -d' ' -f2)"

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

# abstract updating from git or curl
function dotfiles::repo::get::git () {
  git clone "${REPO_BASE}" "${1}"
}

function dotfiles::repo::get::curl () {
  curl -#L "$REPO_BASE/tarball/master" | tar -C "${1}" -xzv --strip-components 1
}

function dotfiles::repo::get () {
  # sanity check, git is now required for auto install
  if type git &>/dev/null; then
    dotfiles::repo::get::git "${DOTFILES_ROOT}"
  else
    dotfiles::repo::get::curl "${DOTFILES_ROOT}"
  fi
}

function dotfiles::repo::update::git () {
  # check if there are git changes
  if git -C "${1}" diff-index --quiet HEAD -- &> /dev/null; then
    # no changes
    git -C "${1}" pull origin master || return 1
  else
    # changes
    git -C "${1}" stash || true
    git -C "${1}" pull origin master || return 1
    git -C "${1}" stash pop || true
  fi
}

function dotfiles::repo::update () {
  # sanity check, git is now required for auto install
  if type git &>/dev/null; then
    dotfiles::repo::update::git "${DOTFILES_ROOT}"
  else
    dotfiles::repo::get::curl "${DOTFILES_ROOT}"
  fi
}

# this is a fresh install
function dotfiles::install () {
  # attempt to make the dotfiles directory
  mkdir -p "${DOTFILES_ROOT}" || return 1

  # download the latest version
  dotfiles::repo::get

  # Install vundle
  if [[ "${DOTFILES__INSTALL_VIMRC}" -eq 1 ]] && type git &>/dev/null; then
    git clone https://github.com/VundleVim/Vundle.vim.git "${DOTFILES_ROOT}/vim/bundle/Vundle.vim"
    if type vim &>/dev/null; then
      echo "--------------- Please Run: 'vim +BundleInstall +qall' after installation"
    fi
  fi
}

# update the dotfiles
function dotfiles::update () {
  ## update to the latest version
  dotfiles::repo::update

  # Update vundle
  if [[ -e "${DOTFILES_ROOT}/vim/bundle/Vundle.vim" ]] && type git &>/dev/null; then
    git -C "${DOTFILES_ROOT}/vim/bundle/Vundle.vim" pull origin master
    vim +PluginInstall +qall
    if type vim &>/dev/null; then
      echo "--------------- Please Run: 'vim +BundleInstall +qall' after installation"
    fi
  fi
}

# make the dotfiles directory
if [[ ! -d "${DOTFILES_ROOT}" ]]; then
  # we don't have anything
  DOTFILES_EXEC=dotfiles::install
else
  # just update
  DOTFILES_EXEC=dotfiles::update
fi

# try to install or update the files
if ! ${DOTFILES_EXEC}; then
  echo "there has been an issue installing dotfiles, please install manually"
  exit 1
fi

# symlink all the files
for file in "${LINKED_FILES[@]}"; do
  dotfiles::link "${file}"
done

# done
echo
echo -e "\033[1mDotfiles has been installed/updated, please reload your session.\033[0m"
