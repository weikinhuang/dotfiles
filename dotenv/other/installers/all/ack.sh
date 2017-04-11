#!/bin/bash

function process-latest-version() {
	github-tags petdance/ack2 | head -n 1
}

function install-app() {
	make-target ~/bin
	curl "http://beyondgrep.com/ack-$(get-latest-version)-single-file" > ~/bin/ack && chmod 0755 ~/bin/ack
}

function application-exists() {
	type ack &> /dev/null
}

function get-current-version() {
	if ! application-exists; then
		return
	fi
	ack --version | grep ^ack | sed 's/ack //'
}
