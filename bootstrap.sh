#!/bin/bash

for file in {bash_profile,bashrc,dotenv,inputrc,screenrc,wgetrc}; do
	[ -f "$HOME/.$file" ] && mv "$HOME/.$file" "$HOME/.$file.bak"
	[ -f "$PWD/.$file" ] && ln -s "$PWD/.$file" "$HOME/.$file"
done
