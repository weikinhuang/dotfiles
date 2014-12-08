#!/bin/bash

if [[ ! -d ~/bin ]]; then
	mkdir ~/bin
fi

ACK_VERSION_FULL="$(curl -s https://api.github.com/repos/petdance/ack2/tags | grep '"name": "' | grep -v "RC\|beta\|alpha" | sort -r --version-sort | head -n 1 | sed 's/.*"name": "\([0123456789._]\+\)",.*/\1/')"

curl "http://beyondgrep.com/ack-${ACK_VERSION_FULL}-single-file" > ~/bin/ack && chmod 0755 !#:3
