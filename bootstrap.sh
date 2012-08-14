#!/bin/bash

# symlink all the files
for file in {bash_profile,bashrc,dotenv,hushlogin,inputrc,mongorc.js,screenrc,wgetrc}; do
	[ -e "$HOME/.$file.bak" ] && rm -f "$HOME/.$file.bak"
	[ -e "$HOME/.$file" ] && mv "$HOME/.$file" "$HOME/.$file.bak"
	[ -e "$PWD/.$file" ] && echo "linking up '$PWD/.$file' => '$HOME/.$file'" && ln -sf "$PWD/.$file" "$HOME/.$file" || echo "Unable to symlink '$HOME/.$file'"
done

# source the files
source ~/.bashrc

# go back to the home directory
cd
