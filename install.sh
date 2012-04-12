#!/bin/bash

# Check out which env this bash is running in
DOTENV="linux"
case "$(uname -s)" in
    CYGWIN* )
        DOTENV="cygwin"
		;;
    Darwin )
        DOTENV="darwin"
		;;
esac
HOME='.'
REMOTE_BASE_URL="https://raw.github.com/weikinhuang/dotfiles/master"
MAX_JOBS=$(grep "^processor" -c /proc/cpuinfo)

# list of files that need to be downloaded
FILES_BASE="bash_profile,bashrc,inputrc"
FILES_DOTENV="aliases,completion,exports,functions,prompt"
FILES_DOTENV_OS="aliases,completion,env,exports,functions,prompt"

rm -rf "${HOME}/.dotenv/${DOTENV}/"
# make the directory tree
if [ -d "${HOME}/.dotenv.bak" ] ; then
	echo "Deleting: '${HOME}/.dotenv.bak'"
	rm -rf "${HOME}/.dotenv.bak"
fi
if [ -d "${HOME}/.dotenv" ] ; then
	echo "Moving directory: '${HOME}/.dotenv' to '${HOME}/.dotenv.bak'"
	mv "${HOME}/.dotenv" "${HOME}/.dotenv.bak"
fi
echo "Creating directory tree: '${HOME}/.dotenv/${DOTENV}/'"
mkdir -p "${HOME}/.dotenv/${DOTENV}/"

# pull down the source files
echo "${FILES_BASE}" | tr ',' '\n' | xargs -I {} -r -P $MAX_JOBS sh -c "\
	echo 'Downloading file {} from ${REMOTE_BASE_URL}/.{} => ${HOME}/.{}'; \
	if [ -f '${HOME}/.{}.bak' ] ; then
		rm -f '${HOME}/.{}.bak'; \
	fi; \
	if [ -f '${HOME}/.{}' ] ; then
		mv '${HOME}/.{}' '${HOME}/.{}.bak'; \
	fi; \
	curl -s -o '${HOME}/.{}' '${REMOTE_BASE_URL}/.{}';"

# pull down the source files
echo "${FILES_DOTENV}" | tr ',' '\n' | xargs -I {} -r -P $MAX_JOBS sh -c "\
	echo 'Downloading file {} from ${REMOTE_BASE_URL}/.dotenv/.{} => ${HOME}/.dotenv/.{}'; \
	if [ -f '${HOME}/.dotenv/.{}.bak' ] ; then
		rm -f '${HOME}/.dotenv/.{}.bak'; \
	fi; \
	if [ -f '${HOME}/.dotenv/.{}' ] ; then
		mv '${HOME}/.dotenv/.{}' '${HOME}/.dotenv/.{}.bak'; \
	fi; \
	curl -s -o '${HOME}/.dotenv/.{}' '${REMOTE_BASE_URL}/.dotenv/.{}';"

# pull down the source files
echo "${FILES_DOTENV_OS}" | tr ',' '\n' | xargs -I {} -r -P $MAX_JOBS sh -c "\
	echo 'Downloading file {} from ${REMOTE_BASE_URL}/.dotenv/${DOTENV}/.{} => ${HOME}/.dotenv/${DOTENV}/.{}'; \
	if [ -f '${HOME}/.dotenv/${DOTENV}/.{}.bak' ] ; then
		rm -f '${HOME}/.dotenv/${DOTENV}/.{}.bak'; \
	fi; \
	if [ -f '${HOME}/.dotenv/${DOTENV}/.{}' ] ; then
		mv '${HOME}/.dotenv/${DOTENV}/.{}' '${HOME}/.dotenv/${DOTENV}/.{}.bak'; \
	fi; \
	curl -s -o '${HOME}/.dotenv/${DOTENV}/.{}' '${REMOTE_BASE_URL}/.dotenv/${DOTENV}/.{}';"


