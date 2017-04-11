#!/bin/bash

function get-install-target() {
	echo "$HOME/bin/"
}

function process-latest-version() {
	github-releases MSOpenTech/redis | sed 's/^win-//' | grep '^[0-9]\+\.[0-9]\+\.[0-9]\+' | head -n 1
}

function get-download-file-name() {
	local LATEST_VERSION=$(get-latest-version)
	if echo "$LATEST_VERSION" | grep '^[0-9]\+\.[0-9]\+\.[0-9]\+\.[0-9]\+$' >/dev/null; then
		LATEST_VERSION=$(echo "$LATEST_VERSION" | sed 's/\.[0-9]\+$//')
	fi
	echo Redis-x64-${LATEST_VERSION}.zip
}

function download-files() {
	local DL_FILE=$(get-download-file-name)
	local LATEST_VERSION=$(get-latest-version)
	local DOWNLOAD_URL="https://github.com/MSOpenTech/redis/releases/download/win-${LATEST_VERSION}/${DL_FILE}"

	if [[ -e "${DL_FILE}" ]]; then
		return 0
	fi
	wget "${DOWNLOAD_URL}"
}

function cleanup-download() {
	rm -f "$(get-download-file-name)"
}

function install-app() {
	local INSTALL_TARGET="$(get-install-target)"
	local REDIS_FILE=$(get-download-file-name)
	make-target "$INSTALL_TARGET"
	download-files

	rm -f "$INSTALL_TARGET/redis-server.exe"
	unzip ${REDIS_FILE} redis-server.exe
	chmod +x redis-server.exe
	mv redis-server.exe "$INSTALL_TARGET"

	rm -f "$INSTALL_TARGET/redis-cli.exe"
	unzip ${REDIS_FILE} redis-cli.exe
	chmod +x redis-cli.exe
	mv redis-cli.exe "$INSTALL_TARGET"

	if [[ ! -e "$INSTALL_TARGET/redis.conf" ]]; then
		unzip ${REDIS_FILE} redis.windows.conf
		chmod -x redis.windows.conf
		mv redis.windows.conf "$INSTALL_TARGET/redis.conf"
	fi

	cleanup-download
}

function application-exists() {
	type redis-cli &> /dev/null
}

function get-current-version() {
	if ! application-exists; then
		return
	fi
	redis-cli --help 2>&1 | head -n1 | sed 's/redis-cli //'
}
