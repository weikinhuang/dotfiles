#!/bin/bash

# variables
REPO_BASE="https://github.com/weikinhuang/dotfiles"
LINKED_FILES="bash_profile bashrc dotenv hushlogin inputrc mongorc.js screenrc wgetrc"
INSTALL_ROOT="$HOME"

# link up gitconfig and vim if specified
if [[ -z $# ]]; then
	for arg in "$@"; do
		case "$arg" in
		--git|-g)
			LINKED_FILES="$LINKED_FILES gitconfig"
			;;
		--vim|-v)
			LINKED_FILES="$LINKED_FILES vimrc vim"
			;;
		--dir|-d)
			shift 1
			echo "$1"
		esac
	done
else
	[[ -z $DT_GIT ]] && LINKED_FILES="$LINKED_FILES gitconfig"
	[[ -z $DT_VIM ]] && LINKED_FILES="$LINKED_FILES vimrc vim"
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
	# remove the backup first
	[[ -e "$INSTALL_ROOT/$file.bak" ]] && rm -f "$INSTALL_ROOT/$file.bak"
	# create the backup file
	[[ -e "$INSTALL_ROOT/$file" ]] && mv "$INSTALL_ROOT/$file" "$INSTALL_ROOT/$file.bak"
	# link up the file
	if [[ -e "$DOTFILES_ROOT/$file" ]]; then
		echo "linking up '$DOTFILES_ROOT/$file' => '$INSTALL_ROOT/$file'"
		if ! ln -sf "$DOTFILES_ROOT/$file" "$INSTALL_ROOT/$file"; then
			echo "Unable to symlink '$INSTALL_ROOT/$file'"
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
	else
		download_dotfiles "$DOTFILES_ROOT" || return 1
	fi
}

# we want to install this in the home directory
cd "$INSTALL_ROOT"

# make the dotfiles directory
if [[ ! -d "$DOTFILES_ROOT" ]]; then
	DOTFILES_EXEC=install_dotfiles
else
	DOTFILES_EXEC=update_dotfiles
fi

# try to install or update the files
if ! $DOTFILES_EXEC; then
	echo "there has been an issue installing dotfiles, please install manually"
	exit 1
fi

# symlink all the files
for file in $LINKED_FILES; do
	link_file ".$file"
done

# done
echo
echo -e "\033[1mDotfiles has been installed/updated, please reload your session.\033[0m"
