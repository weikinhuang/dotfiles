#!/bin/bash

# link up files
function link_files () {
	file=$1
	[ -e "$HOME/$file.bak" ] && rm -f "$HOME/$file.bak"
	[ -e "$HOME/$file" ] && mv "$HOME/$file" "$HOME/$file.bak"
	[ -e "$PWD/$file" ] && echo "linking up '$PWD/$file' => '$HOME/$file'" && ln -sf "$PWD/$file" "$HOME/$file" || echo "Unable to symlink '$HOME/$file'"
}

# symlink all the files
for file in {bash_profile,bashrc,dotenv,hushlogin,inputrc,mongorc.js,screenrc,wgetrc}; do
	link_files ".$file"
done

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

# go back to the home directory
cd ~

# source the files
source ~/.bashrc
