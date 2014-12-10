#!/bin/bash

function github-tags () {
	local REPO_PATH="$1"
	if [[ -z $REPO_PATH ]]; then
		return 1
	fi

	local DONE=0
	local COUNTER=1
	local OUTPUT=""

	while [ $DONE -eq 0 ]; do
		CURL_OUTPUT="$(curl -is https://api.github.com/repos/$REPO_PATH/tags?page=$COUNTER)"
		if ! (grep '^Link: ' <<< "$CURL_OUTPUT" | grep 'rel="next"') &> /dev/null; then
			DONE=1
		fi
		OUTPUT="$OUTPUT$CURL_OUTPUT"
		COUNTER=$(($COUNTER + 1))
	done

	echo "$OUTPUT" | grep '"name": "' | grep -vi "RC\|beta\|alpha" | sed 's/.*"name": "\([^"]\+\)",.*/\1/' | sort -r --version-sort
}

function go-to-workdir () {
	cd /tmp
}

function make-target () {
	if [[ ! -e "$1" ]]; then
		mkdir -p "$1"
	fi
}

function get-cache-tmp-file () {
	echo /tmp/.installer-ver-file-${APPLICATION_NAME}
}

function cache-latest-version () {
	local TMP_FILE=$(get-cache-tmp-file)
	touch $TMP_FILE
	date +%s > $TMP_FILE
	echo "$1" >> $TMP_FILE
}

function get-cached-latest-version () {
	local TMP_FILE=$(get-cache-tmp-file)
	if [[ ! -e $TMP_FILE ]]; then
		return 1
	fi
	local CACHED_VERSION_DATA="$(cat $TMP_FILE)"
	# 1 hr expiry
	if [[ $(cat $TMP_FILE | head -n 1) > $(( $(date +%s) - 3600 )) ]]; then
		cat $TMP_FILE | head -n 2 | tail -n 1
		return 0
	fi
	return 1
}

# @TODO: replace with a file
LATEST_VERSION=
function get-latest-version () {
	if [[ -z $LATEST_VERSION ]]; then
		LATEST_VERSION=$(get-cached-latest-version)
		if [[ -z $LATEST_VERSION ]]; then
			LATEST_VERSION=$(process-latest-version)
			cache-latest-version $LATEST_VERSION
		fi
	fi
	echo $LATEST_VERSION
}

function need-upgrade-or-install () {
	return ! application-exists &> /dev/null || [[ $(get-current-version) != $(get-latest-version) ]]
}
