#!/bin/bash

# variables
REPO_BASE="https://github.com/weikinhuang/dotfiles"
DOTFILES_ROOT="$HOME/.dotfiles"

# check if git exists
HAS_GIT=
if type git &> /dev/null; then
	HAS_GIT=
fi

# link up files
function link_files () {
	file="$1"
	# remove the backup first
	[[ -e "$HOME/$file.bak" ]] && rm -f "$HOME/$file.bak"
	# create the backup file
	[[ -e "$HOME/$file" ]] && mv "$HOME/$file" "$HOME/$file.bak"
	# link up the file
	if [[ -e "$DOTFILES_ROOT/$file" ]]; then
		echo "linking up '$DOTFILES_ROOT/$file' => '$HOME/$file'"
		if ! ln -sf "$DOTFILES_ROOT/$file" "$HOME/$file"; then
			echo "Unable to symlink '$HOME/$file'"
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
cd "$HOME"

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
for file in {bash_profile,bashrc,dotenv,hushlogin,inputrc,mongorc.js,screenrc,wgetrc}; do
	link_files ".$file"
done

# link up gitconfig and vim if specified
for arg in "$@"; do
	case "$arg" in
	--git)
		link_files ".gitconfig"
		;;
	--vim)
		link_files ".vimrc"
		link_files ".vim"
		;;
	esac
done

# done
echo
echo -e "\033[1mDotfiles has been installed/updated, please reload your session.\033[0m"
