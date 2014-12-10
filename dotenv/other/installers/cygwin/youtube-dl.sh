#!/bin/bash

function process-latest-version () {
	github-tags rg3/youtube-dl | head -n 1
}

function install-app () {
	make-target ~/bin
	curl "https://yt-dl.org/downloads/$(get-latest-version)/youtube-dl" > ~/bin/youtube-dl && chmod 0755 ~/bin/youtube-dl
}

function application-exists () {
	type youtube-dl &> /dev/null
}

function get-current-version () {
	if ! application-exists; then
		return
	fi
	youtube-dl --version
}
