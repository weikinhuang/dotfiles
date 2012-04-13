#!/bin/bash

# constants
REMOTE_BASE_URL="https://raw.github.com/weikinhuang/dotfiles/master"
MAX_JOBS=$(grep "^processor" -c /proc/cpuinfo)

# list of files that need to be downloaded
FILES_BASE=".bash_profile,.bashrc,.inputrc"
FILES_DOTENV=".aliases,.completion,.exports,.functions,.prompt"
FILES_DOTENV_OS=".aliases,.completion,.env,.exports,.functions,.prompt"

FILES_DOTENV_BIN="ack,dusort,json,rename"

# Check out which env this bash is running in
DOTENV="linux"
FILES_DOTENV_OS_BIN=""
case "$(uname -s)" in
    CYGWIN* )
        DOTENV="cygwin"
		FILES_DOTENV_OS_BIN="apt-cyg,chattr"
		;;
    Darwin )
        DOTENV="darwin"
		FILES_DOTENV_OS_BIN=""
		;;
esac

function download_files () {
	local dl_list="$1"
	local dl_root="$2"
	local dl_dest="$3"
	
	# pull down the source files
	echo "${dl_list}" | tr ',' '\n' | xargs -I {} -r -P $MAX_JOBS sh -c "\
		echo 'Downloading file {} from ${REMOTE_BASE_URL}/${dl_root}/{} => ${dl_dest}/{}'; \
		if [ -f '${dl_dest}/{}.bak' ] ; then
			rm -f '${dl_dest}/{}.bak'; \
		fi; \
		if [ -f '${dl_dest}/{}' ] ; then
			mv '${dl_dest}/{}' '${dl_dest}/{}.bak'; \
		fi; \
		curl -s -o '${dl_dest}/{}' '${REMOTE_BASE_URL}/${dl_root}/{}';"
}
function download_apps () {
	local dl_list="$1"
	local dl_root="$2"
	local dl_dest="$3"
	
	# pull down the source files
	echo "${dl_list}" | tr ',' '\n' | xargs -I {} -r -P $MAX_JOBS sh -c "\
		echo 'Downloading file {} from ${REMOTE_BASE_URL}/${dl_root}/{} => ${dl_dest}/{}'; \
		if [ -f '${dl_dest}/{}' ] ; then
			rm -f '${dl_dest}/{}'; \
		fi; \
		curl -s -o '${dl_dest}/{}' '${REMOTE_BASE_URL}/${dl_root}/{}';"
}

# make the directory tree
if [ -d "${HOME}/.dotenv.bak" ] ; then
	echo "Deleting: '${HOME}/.dotenv.bak'"
	rm -rf "${HOME}/.dotenv.bak"
fi
if [ -d "${HOME}/.dotenv" ] ; then
	echo "Moving directory: '${HOME}/.dotenv' to '${HOME}/.dotenv.bak'"
	mv "${HOME}/.dotenv" "${HOME}/.dotenv.bak"
fi

echo "Creating directory tree: '${HOME}/.dotenv/bin/'"
mkdir -p "${HOME}/.dotenv/bin/"
echo "Creating directory tree: '${HOME}/.dotenv/${DOTENV}/'"
mkdir -p "${HOME}/.dotenv/${DOTENV}/"
echo "Creating directory tree: '${HOME}/.dotenv/${DOTENV}/bin/'"
mkdir -p "${HOME}/.dotenv/${DOTENV}/bin/"
echo ""

# pull down the source files
download_files "${FILES_BASE}" "" "${HOME}"
download_files "${FILES_DOTENV}" ".dotenv" "${HOME}/.dotenv"
download_files "${FILES_DOTENV_OS}" ".dotenv/${DOTENV}" "${HOME}/.dotenv/${DOTENV}"

download_apps "${FILES_DOTENV_BIN}" ".dotenv/bin" "${HOME}/.dotenv/bin"
download_apps "${FILES_DOTENV_OS_BIN}" ".dotenv/${DOTENV}/bin" "${HOME}/.dotenv/${DOTENV}/bin"
