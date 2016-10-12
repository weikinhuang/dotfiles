#!/bin/bash

# variables
REPO_BASE="https://github.com/weikinhuang/dotfiles"
LINKED_FILES="bash_profile bashrc dotenv hushlogin inputrc mongorc.js screenrc wgetrc"
INSTALL_ROOT="$HOME"
INSTALL_VIMRC=
INSTALL_GITCONFIG=

# link up gitconfig and vim if specified
if [[ -n $# ]] && [[ -t 0 ]]; then
    for arg in "$@"; do
        case "$arg" in
        --git|-g)
            LINKED_FILES="$LINKED_FILES gitconfig"
            INSTALL_GITCONFIG=1
            ;;
        --vim|-v)
            LINKED_FILES="$LINKED_FILES vimrc vim"
            INSTALL_VIMRC=1
            ;;
        --dir|-d)
            shift 1
            INSTALL_ROOT="$1"
        esac
    done
else
    [[ -z $DT_GIT ]] && LINKED_FILES="$LINKED_FILES gitconfig" && INSTALL_GITCONFIG=1
    [[ -z $DT_VIM ]] && LINKED_FILES="$LINKED_FILES vimrc vim" && INSTALL_VIMRC=1
    [[ -n $DT_DIR ]] && INSTALL_ROOT="$DT_DIR"
fi

# root directory to install into
DOTFILES_ROOT="$INSTALL_ROOT/.dotfiles"

# check if git exists
HAS_GIT=
if type git &> /dev/null; then
    HAS_GIT=1
fi

# link up files
function link_file () {
    file="$1"
    target="$2"
    # remove the backup first
    [[ -e "$INSTALL_ROOT/$target.bak" ]] && rm -f "$INSTALL_ROOT/$target.bak"
    # create the backup file
    [[ -e "$INSTALL_ROOT/$target" ]] && mv "$INSTALL_ROOT/$target" "$INSTALL_ROOT/$target.bak"
    # link up the file
    if [[ -e "$DOTFILES_ROOT/$file" ]]; then
        echo "linking up '$DOTFILES_ROOT/$file' => '$INSTALL_ROOT/$target'"
        if ! ln -sf "$DOTFILES_ROOT/$file" "$INSTALL_ROOT/$target"; then
            echo "Unable to symlink '$INSTALL_ROOT/$target'"
        fi
    fi
}

# download using curl
function download_dotfiles () {
    curl -#L "$REPO_BASE/tarball/master" | tar -C "$1" -xzv --strip-components 1 || return 1
}

# this is a fresh install
function install_dotfiles () {
    # attempt to make the dotfiles directory
    mkdir -p "$DOTFILES_ROOT" || return 1

    # do all of our work in here
    cd "$DOTFILES_ROOT" || return 1

    # download the latest version
    if [[ $HAS_GIT == 1 ]]; then
        git clone "$REPO_BASE.git" . || return 1
    else
        download_dotfiles "$DOTFILES_ROOT" || return 1
    fi

    # Install vundle
    if [[ $HAS_GIT == 1 ]] && [[ $INSTALL_VIMRC == 1 ]]; then
        cd "$DOTFILES_ROOT/vim/bundle"
        git clone https://github.com/VundleVim/Vundle.vim.git
        cd "$DOTFILES_ROOT"
        if type vim &>/dev/null && [[ -e /dev/tty ]]; then
            vim +BundleInstall +qall < /dev/tty
        fi
    fi
}

# update the dotfiles
function update_dotfiles () {
    # do all of our work in here
    cd "$DOTFILES_ROOT" || return 1

    if [[ $HAS_GIT == 1 ]]; then
        # check if there are git changes
        if git diff-index --quiet HEAD -- &> /dev/null; then
            # no changes
            git pull origin master || return 1
        else
            # changes
            git stash || return 1
            git pull origin master || return 1
            git stash pop || return 1
        fi

        # Update vundle
        if [[ -e "$DOTFILES_ROOT/vim/bundle/Vundle.vim" ]]; then
            cd "$DOTFILES_ROOT/vim/bundle/Vundle.vim"
            git pull origin master
            cd "$DOTFILES_ROOT"
            vim +PluginInstall +qall
            if type vim &>/dev/null && [[ -e /dev/tty ]]; then
                vim +BundleInstall +qall < /dev/tty
            fi
        fi
    else
        download_dotfiles "$DOTFILES_ROOT" || return 1
    fi
}

# we want to install this in the home directory
cd "$INSTALL_ROOT"

# make the dotfiles directory
if [[ ! -d "$DOTFILES_ROOT" ]]; then
    # we don't have anything
    DOTFILES_EXEC=install_dotfiles
elif [[ ! -d "$DOTFILES_ROOT/.git" ]] && [[ $HAS_GIT == 1 ]]; then
    # we are upgrading from no git to git managed
    mv "$DOTFILES_ROOT" "$DOTFILES_ROOT.bak"
else
    # just update
    DOTFILES_EXEC=update_dotfiles
fi

# try to install or update the files
if ! $DOTFILES_EXEC; then
    echo "there has been an issue installing dotfiles, please install manually"
    exit 1
fi

# symlink all the files
for file in $LINKED_FILES; do
    link_file "$file" ".$file"
done

# done
echo
echo -e "\033[1mDotfiles has been installed/updated, please reload your session.\033[0m"
