#!/bin/bash

INSTALL_TARGET="$HOME/bin/"
MONGO_STABLE_VERSION="$(curl -s https://api.github.com/repos/mongodb/mongo/tags | grep '"name": "r' | grep -vi "RC\|beta\|alpha" | sed 's/.*"name": "r\([0123456789.]\+\)",.*/\1/' | awk -F. '$2 % 2 == 0 { print $0 }' | sort -r --version-sort | head -n 1)"

if [[ "$(uname -m)" == "x86_64" ]]; then
	MONGO_FILE="mongodb-win32-x86_64-2008plus-${MONGO_STABLE_VERSION}"
else
	MONGO_FILE="mongodb-win32-i386-${MONGO_STABLE_VERSION}"
fi
MONGO_ZIP_FILE="${MONGO_FILE}.zip"
MONGO_DOWNLOAD_URL="https://fastdl.mongodb.org/win32/${MONGO_ZIP_FILE}"

function get-mongodb () {
	if [[ -e "${MONGO_ZIP_FILE}" ]]; then
		cleanup-installer
		return 0
	fi
	wget "${MONGO_DOWNLOAD_URL}"
}


# install with msiexec
function install-mongodb () {
	rm -f "$INSTALL_TARGET/mongod.exe"
	unzip -j ${MONGO_ZIP_FILE} ${MONGO_FILE}/bin/mongod.exe
	chmod +x mongod.exe
	mv mongod.exe "$INSTALL_TARGET"

	rm -f "$INSTALL_TARGET/mongo.exe"
	unzip -j ${MONGO_ZIP_FILE} ${MONGO_FILE}/bin/mongo.exe
	chmod +x mongo.exe
	mv mongo.exe "$INSTALL_TARGET"
}

function cleanup-installer () {
	rm -f "${MONGO_ZIP_FILE}"
}

# go to work dir
cd /tmp

if [[ ! -e "$INSTALL_TARGET" ]]; then
	mkdir "$INSTALL_TARGET"
fi

# we have mongodb installed
if mongod -v &> /dev/null; then
	# need upgrade...
	if [[ "$(mongodb --version | head -n1 )" != "db version v${MONGO_STABLE_VERSION}" ]]; then
		echo "Upgrading mongodb v${MONGO_STABLE_VERSION}"
		get-mongodb
		install-mongodb
		cleanup-installer
	fi
else
	echo "Installing mongodb v${MONGO_STABLE_VERSION}"
	get-mongodb
	install-mongodb
	cleanup-installer
fi
