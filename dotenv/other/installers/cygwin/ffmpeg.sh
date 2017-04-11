#!/bin/bash

function get-install-target() {
	echo "$HOME/bin/"
}

function process-latest-version() {
	get-download-file-name | sed 's/ffmpeg-\([0-9]\+\)-git-\([a-f0-9]\+\)-.\+$/\2/'
}

function get-download-file-name() {
	local FFMPEG_ARCH
	if [[ "$(uname -m)" == "x86_64" ]]; then
		FFMPEG_ARCH=win64
	else
		FFMPEG_ARCH=win32
	fi
	curl -s http://ffmpeg.zeranoe.com/builds/ | grep 'class="latest"' | grep static | sed 's/^.\+href=".\/\(.\+\?\)".\+$/\1/' | grep -vi readme | grep $FFMPEG_ARCH | head -n 1 | cut -d/ -f3
}

function download-files() {
	local DL_FILE=$(get-download-file-name)
	local FFMPEG_ARCH
	if [[ "$(uname -m)" == "x86_64" ]]; then
		FFMPEG_ARCH=win64
	else
		FFMPEG_ARCH=win32
	fi
	local DOWNLOAD_URL=http://ffmpeg.zeranoe.com/builds/$FFMPEG_ARCH/static/${DL_FILE}

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
	local ARCHIVE_FILE=$(get-download-file-name)
	local ARCHIVE_NAME=$(get-download-file-name | sed 's/\.7z$//')
	make-target "$INSTALL_TARGET"
	download-files

	rm -f "$INSTALL_TARGET/ffmpeg.exe"
	rm -f "$INSTALL_TARGET/ffplay.exe"
	rm -f "$INSTALL_TARGET/ffprobe.exe"

	7za e $ARCHIVE_FILE $ARCHIVE_NAME/bin/ffmpeg.exe
	7za e $ARCHIVE_FILE $ARCHIVE_NAME/bin/ffplay.exe
	7za e $ARCHIVE_FILE $ARCHIVE_NAME/bin/ffprobe.exe

	chmod +x ffmpeg.exe
	chmod +x ffplay.exe
	chmod +x ffprobe.exe

	mv ffmpeg.exe "$INSTALL_TARGET"
	mv ffplay.exe "$INSTALL_TARGET"
	mv ffprobe.exe "$INSTALL_TARGET"

	cleanup-download
}

function application-exists() {
	type ffmpeg &> /dev/null
}

function get-current-version() {
	if ! application-exists; then
		return
	fi
	ffmpeg -version | head -n1 | sed 's/ffmpeg version N-[0-9]\+-[a-z]\([a-f0-9]\+\) .\+$/\1/'
}
