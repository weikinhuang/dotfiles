#!/bin/bash

function get-install-target() {
	echo "$HOME/bin/"
}

function process-latest-version() {
	github-tags mongodb/mongo | grep '^r' | sed 's/^r//' | awk -F. '$2 % 2 == 0 { print $0 }' | head -n 1
}

function get-download-file-name() {
	local LATEST_VERSION=$(get-latest-version)

	if [[ "$(uname -m)" == "x86_64" ]]; then
		echo "mongodb-win32-x86_64-2008plus-${LATEST_VERSION}"
	else
		echo "mongodb-win32-i386-${LATEST_VERSION}"
	fi
}

function download-files() {
	local MONGO_FILE=$(get-download-file-name)
	local MONGO_DOWNLOAD_URL="https://fastdl.mongodb.org/win32/${MONGO_FILE}.zip"

	if [[ -e "${MONGO_FILE}.zip" ]]; then
		return 0
	fi
	wget "${MONGO_DOWNLOAD_URL}"
}

function cleanup-download() {
	rm -f "$(get-download-file-name).zip"
}

function install-app() {
	local INSTALL_TARGET="$(get-install-target)"
	local MONGO_FILE=$(get-download-file-name)
	make-target "$INSTALL_TARGET"
	download-files

	rm -f "$INSTALL_TARGET/mongod.exe"
	unzip -j ${MONGO_FILE}.zip ${MONGO_FILE}/bin/mongod.exe
	chmod +x mongod.exe
	mv mongod.exe "$INSTALL_TARGET"

	rm -f "$INSTALL_TARGET/mongo.exe"
	unzip -j ${MONGO_FILE}.zip ${MONGO_FILE}/bin/mongo.exe
	chmod +x mongo.exe
	mv mongo.exe "$INSTALL_TARGET"

	cleanup-download
}

function application-exists() {
	type mongod &> /dev/null
}

function get-current-version() {
	if ! application-exists; then
		return
	fi
	mongod --version | head -n1 | sed 's/db version v//'
}
