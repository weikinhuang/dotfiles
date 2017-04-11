#!/bin/bash

if [[ "$1" == "install" ]]; then
	~/.dotenv/other/exec-installer.sh $2 install
	EXIT_STATUS=$?
	if [[ $EXIT_STATUS -eq 2 ]]; then
		echo "Already installed and latest"
	fi
	exit $EXIT_STATUS
fi

shopt -s nullglob
LINE='                                 '

function print-info() {
	local APPNAME=$(basename $file | sed 's/\.sh$//')
	local IS_INSTALLED
	if ~/.dotenv/other/exec-installer.sh $APPNAME exists; then
		IS_INSTALLED=$(echo -e "\033[0;32mINSTALLED\033[0m")
	else
		IS_INSTALLED=$(echo -e "\033[0;31mMISSING\033[0m")
	fi
	printf "    %s %s [%s]\n" $(echo -e "\033[1m$APPNAME\033[0m") "${LINE:${#APPNAME}}" $IS_INSTALLED
}

echo "Set up dev environment applications!"
echo
for file in ~/.dotenv/other/installers/$DOTENV/*.sh; do
	print-info $file
done
for file in ~/.dotenv/other/installers/all/*.sh; do
	print-info $file
done
unset file

echo
echo -e "Type $0 install \033[1mAPPNAME\033[0m to install a application"
