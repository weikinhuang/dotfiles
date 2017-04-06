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
  "curlrc .curlrc"
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
function dotfiles::install::link () {
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
function dotfiles::install::repo::get::git () {
  local GITHUB_URL="${1}"
  local DIR="${2}"
  git clone "${GITHUB_URL}" "${DIR}"
}

function dotfiles::install::repo::get::curl () {
  local GITHUB_URL="${1}"
  local DIR="${2}"
  mkdir -p "${DIR}"
  curl -#L "${GITHUB_URL}/tarball/master" | tar -C "${DIR}" -xzv --strip-components 1
}

function dotfiles::install::repo::get () {
  local GITHUB_URL="${1}"
  local DIR="${2}"
  # sanity check, git is now required for auto install
  if type git &>/dev/null; then
    dotfiles::install::repo::get::git "${GITHUB_URL}" "${DIR}"
  else
    dotfiles::install::repo::get::curl "${GITHUB_URL}" "${DIR}"
  fi
}

function dotfiles::install::repo::update::git () {
  local DIR="${1}"
  # check if there are git changes
  if git -C "${DIR}" diff-index --quiet HEAD -- &> /dev/null; then
    # no changes
    git -C "${DIR}" pull origin master || return 1
  else
    # changes
    git -C "${DIR}" stash || true
    git -C "${DIR}" pull origin master || return 1
    git -C "${DIR}" stash pop || true
  fi
}

function dotfiles::install::repo::update () {
  local GITHUB_URL="${1}"
  local DIR="${2}"
  # sanity check, git is now required for auto install
  if type git &>/dev/null; then
    dotfiles::install::repo::update::git "${DIR}"
  else
    dotfiles::install::repo::get::curl "${GITHUB_URL}" "${DIR}"
  fi
}

# this is a fresh install
function dotfiles::install::install () {
  # attempt to make the dotfiles directory
  mkdir -p "${DOTFILES_ROOT}" || return 1

  # download the latest version
  dotfiles::install::repo::get "${REPO_BASE}" "${DOTFILES_ROOT}"

  # Install vundle
  if [[ "${DOTFILES__INSTALL_VIMRC}" -eq 1 ]]; then
    dotfiles::install::repo::get https://github.com/VundleVim/Vundle.vim "${DOTFILES_ROOT}/vim/bundle/Vundle.vim"
    if type vim &>/dev/null; then
      echo "--------------- Please Run: 'vim +BundleInstall +qall' after installation"
    fi
  fi
}

# update the dotfiles
function dotfiles::install::update () {
  ## update to the latest version
  dotfiles::install::repo::update "${REPO_BASE}" "${DOTFILES_ROOT}"

  # Update vundle
  if [[ -e "${DOTFILES_ROOT}/vim/bundle/Vundle.vim" ]]; then
    dotfiles::install::repo::update https://github.com/VundleVim/Vundle.vim "${DOTFILES_ROOT}/vim/bundle/Vundle.vim"
    vim +PluginInstall +qall
    if type vim &>/dev/null; then
      echo "--------------- Please Run: 'vim +BundleInstall +qall' after installation"
    fi
  fi
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

# done
echo
echo -e "\033[1mDotfiles has been installed/updated, please reload your session.\033[0m"
