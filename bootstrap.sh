#!/bin/bash

for file in {bash_profile,bashrc,dotenv,inputrc,screenrc,wgetrc}; do
	[ -e "$HOME/.$file" ] && mv "$HOME/.$file" "$HOME/.$file.bak"
	[ -e "$PWD/.$file" ] && echo "linking up '$PWD/.$file' => '$HOME/.$file'" && ln -s "$PWD/.$file" "$HOME/.$file"
done
