#!/bin/bash

function regex-replace {
	gawk 'match($0, '$1', ary) { print ary['${2:-'0'}'] }';
}

NODE_VERSION_LATEST="$(curl -s http://nodejs.org/dist/latest/SHASUMS.txt | grep 'node-v[0-9.]\+.tar.gz' | regex-replace '/node-v([0-9.]+).tar.gz/' 1)"

if [[ "$(uname -m)" == "x86_64" ]]; then
	NODE_FILE="node-v${NODE_VERSION_LATEST}-x64.msi"
	NODE_DOWNLOAD_URL="http://nodejs.org/dist/v${NODE_VERSION_LATEST}/x64/${NODE_FILE}"
else
	NODE_FILE="node-v${NODE_VERSION_LATEST}-x86.msi"
	NODE_DOWNLOAD_URL="http://nodejs.org/dist/v${NODE_VERSION_LATEST}/${NODE_FILE}"
fi

function get-node () {
	if [[ -e "${NODE_FILE}" ]]; then
		rm -f "${NODE_FILE}"
		return 0
	fi
	wget "${NODE_DOWNLOAD_URL}"
}

# install with msiexec
function install-node () {
	msiexec /i "${NODE_FILE}" /norestart /passive
}

function cleanup-installer () {
	rm -f "${NODE_FILE}"
}

# go to work dir
cd /tmp

# we have node installed
if node -v &> /dev/null; then
	# need upgrade...
	if [[ "$(node -v)" != "v${NODE_VERSION_LATEST}" ]]; then
		echo "Installing nodejs v${NODE_VERSION_LATEST}"
		get-node
		install-node
		cleanup-installer
	fi
else
	echo "Installing nodejs v${NODE_VERSION_LATEST}"
	get-node
	install-node
	cleanup-installer
fi

# link up npm to appdata folder and install common modules
if [[ ! -d "/c/Users/$USER/AppData/Roaming/npm" ]]; then
	mkdir /c/Users/$USER/AppData/Roaming/npm
fi

"/c/Program Files/nodejs/npm.cmd" install -g npm@latest

if [[ -e "/c/Users/$USER/AppData/Roaming/npm/npm.cmd" ]]; then
	LOCAL_NPM_CMD="/c/Users/$USER/AppData/Roaming/npm/npm.cmd"
else
	LOCAL_NPM_CMD="/c/Program Files/nodejs/npm.cmd"
fi

$LOCAL_NPM_CMD install -g bower node-inspector grunt-cli node-gyp
$LOCAL_NPM_CMD update -g
