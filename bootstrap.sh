#!/bin/bash

# Strict mode http://redsymbol.net/articles/unofficial-bash-strict-mode/
set -euo pipefail
IFS=$'\n\t'

# sanity check, git is now required for auto install
if ! type git &>/dev/null; then
  exit 1
fi

# variables
readonly REPO_BASE="${REPO_BASE:-https://github.com/weikinhuang/dotfiles.git}"
INSTALL_ROOT="${INSTALL_ROOT:-${HOME}}"
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
INSTALL_VIMRC=1
INSTALL_GITCONFIG=1

# link up gitconfig and vim if specified
if [[ -n $# ]]; then
  for arg in "$@"; do
    case "${arg}" in
      --no-git)
        INSTALL_GITCONFIG=0
        ;;
      --no-vim)
        INSTALL_VIMRC=0
        ;;
      --dir|-d)
        shift 1
        INSTALL_ROOT="${1}"
        ;;
    esac
  done
fi

# clean up
if [[ "${INSTALL_VIMRC}" -eq 1 ]]; then
  LINKED_FILES+=("vimrc .vimrc" "vim .vim")
fi
if [[ "${INSTALL_GITCONFIG}" -eq 1  ]]; then
  LINKED_FILES+=("gitconfig .gitconfig")
fi

# root directory to install into
readonly DOTFILES_ROOT="${INSTALL_ROOT}/.dotfiles"

# link up files
function dotfiles::link () {
  local file="$(echo "${1}" | cut -d' ' -f1)"
  local target="$(echo "${1}" | cut -d' ' -f2)"

  # remove the backup first
  [[ -e "${INSTALL_ROOT}/${target}.bak" ]] && rm -f "${INSTALL_ROOT}/${target}.bak"

  # create the backup file if not symlink
  [[ -e "${INSTALL_ROOT}/${target}" && ! -L "${INSTALL_ROOT}/${target}" ]] \
    && mv "${INSTALL_ROOT}/${target}" "${INSTALL_ROOT}/${target}.bak"

  # link up the file
  if [[ -e "${DOTFILES_ROOT}/${file}" ]]; then
    echo "linking up '${DOTFILES_ROOT}/${file}' => '${INSTALL_ROOT}/${target}'"
    if ! ln -sf "${DOTFILES_ROOT}/${file}" "${INSTALL_ROOT}/${target}"; then
      echo "Unable to symlink '${INSTALL_ROOT}/${target}'"
    fi
  fi
}

# this is a fresh install
function dotfiles::install () {
  # attempt to make the dotfiles directory
  mkdir -p "${DOTFILES_ROOT}" || return 1

  # do all of our work in here
  cd "${DOTFILES_ROOT}" || return 1

  # download the latest version
  #git clone "${REPO_BASE}" . || return 1
  cp -R ${REPO_BASE}/* .
  cp -R ${REPO_BASE}/.git .

  # Install vundle
  if [[ "${INSTALL_VIMRC}" -eq 1 ]]; then
    cd "${DOTFILES_ROOT}/vim/bundle"
    git clone https://github.com/VundleVim/Vundle.vim.git
    cd "${DOTFILES_ROOT}"
    if type vim &>/dev/null; then
      echo "--------------- Please Run: 'vim +BundleInstall +qall' after installation"
    fi
  fi
}

# update the dotfiles
function dotfiles::update () {
  # do all of our work in here
  cd "${DOTFILES_ROOT}" || return 1

  # check if there are git changes
  if git diff-index --quiet HEAD -- &> /dev/null; then
    # no changes
    git pull origin master || return 1
  else
    # changes
    git stash || true
    git pull origin master || return 1
    git stash pop || true
  fi

  # Update vundle
  if [[ -e "${DOTFILES_ROOT}/vim/bundle/Vundle.vim" ]]; then
    cd "${DOTFILES_ROOT}/vim/bundle/Vundle.vim"
    git pull origin master
    cd "${DOTFILES_ROOT}"
    vim +PluginInstall +qall
    if type vim &>/dev/null; then
      echo "--------------- Please Run: 'vim +BundleInstall +qall' after installation"
    fi
  fi
}

# we want to install this in the home directory
cd "${INSTALL_ROOT}"

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
