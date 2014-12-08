#!/bin/bash

if [[ ! -d ~/bin ]]; then
	mkdir ~/bin
fi

YT_DL_VERSION_FULL="$(curl -s https://api.github.com/repos/rg3/youtube-dl/tags | grep '"name": "' | grep -v "RC\|beta\|alpha" | sort -r --version-sort | head -n 1 | sed 's/.*"name": "\([0123456789._]\+\)",.*/\1/')"

curl "https://yt-dl.org/downloads/${YT_DL_VERSION_FULL}/youtube-dl" > ~/bin/youtube-dl && chmod 0755 !#:3
