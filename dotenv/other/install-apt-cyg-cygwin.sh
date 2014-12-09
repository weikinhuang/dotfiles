#!/bin/bash

if [[ ! -d ~/bin ]]; then
	mkdir ~/bin
fi

curl -s "https://raw.githubusercontent.com/transcode-open/apt-cyg/master/apt-cyg" > ~/bin/apt-cyg && chmod 0755 ~/bin/apt-cyg
