#!/bin/bash

for file in {exports,functions,aliases,completion,prompt,extra,cygwin}; do
	[ -f "$HOME/.$file" ] && mv "$HOME/.$file" "$HOME/.$file.bak"
	ln -s "$PWD/.$file" "$HOME/.$file"
done
unset file