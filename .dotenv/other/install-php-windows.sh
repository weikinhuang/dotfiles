#!/bin/bash

PHP_VERION_MAJOR=5.6
PECL_MEMCACHE_VERSION=3.0.8
INSTALL_PATH='/c/Program Files (x86)/PHP'

PHP_VERSION_FULL="$(curl -s https://api.github.com/repos/php/php-src/tags | grep '"name": "php-'${PHP_VERION_MAJOR} | grep -v "RC\|beta\|alpha" | sort -r --version-sort | head -n 1 | sed 's/.*"name": "php-\([0123456789.]\+\)",.*/\1/')"
XDEBUG_VERSION="$(curl -s https://api.github.com/repos/xdebug/xdebug/tags | grep '"name": "XDEBUG_' | grep -iv "RC\|beta\|alpha" | sed 's/.*"name": "XDEBUG_\([0123456789_]\+\)",.*/\1/' | tr _ . | sort -r --version-sort | head -n 1)"

PHP_ZIP_FILE=php-${PHP_VERSION_FULL}-nts-Win32-VC11-x86.zip
PECL_MEMCACHE_ZIP_FILE=php_memcache-${PECL_MEMCACHE_VERSION}-${PHP_VERION_MAJOR}-nts-vc11-x86.zip

function get-php () {
	wget http://windows.php.net/downloads/releases/${PHP_ZIP_FILE}
	wget http://windows.php.net/downloads/pecl/releases/memcache/${PECL_MEMCACHE_VERSION}/${PECL_MEMCACHE_ZIP_FILE}

	unzip ${PHP_ZIP_FILE} -d PHP
	unzip ${PECL_MEMCACHE_ZIP_FILE} php_memcache.dll

	rm -f ${PHP_ZIP_FILE}
	rm -f ${PECL_MEMCACHE_ZIP_FILE}

	mv php_memcache.dll PHP/ext/php_memcache.dll

	curl http://xdebug.org/files/php_xdebug-${XDEBUG_VERSION}-${PHP_VERION_MAJOR}-vc11-nts.dll > PHP/ext/php_xdebug.dll

	cp PHP/php.ini-development PHP/php.ini

	echo '; Dev customizations
	post_max_size = 1G
	extension_dir = "ext"
	upload_max_filesize = 1G

	extension=php_curl.dll
	extension=php_fileinfo.dll
	extension=php_gd2.dll
	extension=php_mbstring.dll
	extension=php_xsl.dll
	extension=php_memcache.dll
	zend_extension="php_xdebug.dll"

	date.timezone = America/New_York
	' >> PHP/php.ini

	chmod -R 755 PHP

	if [[ -d "${INSTALL_PATH}" ]]; then
		rm -rf "${INSTALL_PATH}"
	fi

	mv PHP "${INSTALL_PATH}"
}

# go to work dir
cd /tmp

if [[ -d "${INSTALL_PATH}" ]] && type php &> /dev/null && php -v &> /dev/null; then
	# this is a upgrade
	if [[ "$(php -r 'echo phpversion();')" != "${PHP_VERSION_FULL}" ]]; then
		cp "${INSTALL_PATH}/php.ini" php.ini.bak
		get-php
		rm -f "${INSTALL_PATH}/php.ini"
		mv php.ini.bak "${INSTALL_PATH}/php.ini"
	fi
else
	# fresh install
	get-php
fi

# install composer to a local bin dir
if [[ ! -f ~/bin/composer ]]; then
	curl -sS https://getcomposer.org/installer | php
	if [[ ! -d ~/bin ]]; then
		mkdir ~/bin
	fi
	mv composer.phar ~/bin/composer
else
	~/bin/composer self-update
fi
