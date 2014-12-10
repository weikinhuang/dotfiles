#!/bin/bash

APPLICATION_NAME=$1

. ~/.dotenv/other/installers/install-helpers.sh

if [[ -x ~/.dotenv/other/installers/$DOTENV/$APPLICATION_NAME.sh ]]; then
	. ~/.dotenv/other/installers/$DOTENV/$APPLICATION_NAME.sh
elif [[ -x ~/.dotenv/other/installers/all/$APPLICATION_NAME.sh ]]; then
	. ~/.dotenv/other/installers/all/$APPLICATION_NAME.sh
else
	exit 1
fi

case "$2" in
	install)
		if need-upgrade-or-install; then
			go-to-workdir
			install-app
			if type post-install &> /dev/null; then
				post-install
			fi
		else
			exit 2
		fi
		;;
	current-version)
		get-current-version
		;;
	latest-version)
		get-latest-version
		;;
	exists)
		application-exists &> /dev/null
		;;
	*)
		exit 1
		;;
esac
