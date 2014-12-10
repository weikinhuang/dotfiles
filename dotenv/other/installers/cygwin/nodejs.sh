#!/bin/bash

function process-latest-version () {
	github-tags joyent/node | grep '^v' | sed 's/^v//' | awk -F. '$2 % 2 == 0 { print $0 }' | head -n 1
}

function get-download-file-name () {
	local LATEST_VERSION=$(get-latest-version)
	if [[ "$(uname -m)" == "x86_64" ]]; then
		echo "node-v${LATEST_VERSION}-x64.msi"
	else
		echo "node-v${LATEST_VERSION}-x86.msi"
	fi
}

function download-files () {
	local NODE_FILE=$(get-download-file-name)
	local LATEST_VERSION=$(get-latest-version)
	local DOWNLOAD_URL=
	if [[ "$(uname -m)" == "x86_64" ]]; then
		DOWNLOAD_URL="http://nodejs.org/dist/v${NODE_VERSION_LATEST}/x64/${NODE_FILE}"
	else
		DOWNLOAD_URL="http://nodejs.org/dist/v${NODE_VERSION_LATEST}/${NODE_FILE}"
	fi
	
	if [[ -e "${NODE_FILE}" ]]; then
		return 0
	fi
	wget "${NODE_DOWNLOAD_URL}"
}

function cleanup-download () {
	rm -f "$(get-download-file-name)"
}

function install-app () {
	msiexec /i "$(get-download-file-name)" /norestart /passive
}

function post-install () {
	# link up npm to appdata folder and install common modules
	if [[ ! -d "/c/Users/$USER/AppData/Roaming/npm" ]]; then
		mkdir /c/Users/$USER/AppData/Roaming/npm
	fi

	"/c/Program Files/nodejs/npm.cmd" install -g npm@latest

	# fix path for npm command
	PATH="/c/Program Files/nodejs:$PATH"

	if [[ -e "/c/Users/$USER/AppData/Roaming/npm/npm.cmd" ]]; then
		LOCAL_NPM_CMD="/c/Users/$USER/AppData/Roaming/npm/npm.cmd"
	else
		LOCAL_NPM_CMD="/c/Program Files/nodejs/npm.cmd"
	fi

	$LOCAL_NPM_CMD install -g bower node-inspector grunt-cli node-gyp
	$LOCAL_NPM_CMD update -g
}

function application-exists () {
	type node && node -v
}

function get-current-version () {
	node -v | sed 's/^v//'
}
