#!/bin/bash

function process-latest-version () {
	date +%s
}

function install-app () {
	make-target ~/bin
	curl -s "https://raw.githubusercontent.com/transcode-open/apt-cyg/master/apt-cyg" > ~/bin/apt-cyg && chmod 0755 ~/bin/apt-cyg
}

function application-exists () {
	type apt-cyg &> /dev/null
}

function get-current-version () {
	echo
}
