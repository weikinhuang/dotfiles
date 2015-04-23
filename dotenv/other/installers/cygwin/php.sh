#!/bin/bash

PHP_VERION_MAJOR=5.6
PECL_MEMCACHE_VERSION=3.0.8

function get-install-target () {
	if [[ "$(uname -m)" == "x86_64" ]]; then
		echo '/c/Program Files (x86)/PHP'
	else
		echo '/c/Program Files/PHP'
	fi
}

function process-latest-version () {
	github-tags php/php-src | grep '^php-'${PHP_VERION_MAJOR} | sed 's/^php-//' | sort -r --version-sort | head -n 1
}

function process-latest-xdebug-version () {
	github-tags xdebug/xdebug | grep '^XDEBUG_' | sed 's/^XDEBUG_//' | tr _ . | sort -r --version-sort | head -n 1
}

function get-download-file-name () {
	echo php-$(get-latest-version)-nts-Win32-VC11-x86.zip
}

function get-pecl-memcache-file-name () {
	echo php_memcache-${PECL_MEMCACHE_VERSION}-${PHP_VERION_MAJOR}-nts-vc11-x86.zip
}

function download-files () {
	local DL_FILE=$(get-download-file-name)
	
	wget http://windows.php.net/downloads/releases/${DL_FILE}
	wget http://windows.php.net/downloads/pecl/releases/memcache/${PECL_MEMCACHE_VERSION}/$(get-pecl-memcache-file-name)

	curl http://xdebug.org/files/php_xdebug-$(process-latest-xdebug-version)-${PHP_VERION_MAJOR}-vc11-nts.dll > php_xdebug.dll
}

function cleanup-download () {
	rm -f "$(get-download-file-name)"
	rm -f "$(get-pecl-memcache-file-name)"
}

function install-app () {
	download-files
	
	local INSTALL_PATH="$(get-install-target)"

	if [[ -e "${INSTALL_PATH}/php.ini" ]]; then
		cp "${INSTALL_PATH}/php.ini" php.ini.bak
	fi

	unzip $(get-download-file-name) -d PHP
	unzip $(get-pecl-memcache-file-name) php_memcache.dll

	mv php_memcache.dll PHP/ext/php_memcache.dll
	mv php_xdebug.dll PHP/ext/php_xdebug.dll

	if [[ -e php.ini.bak ]]; then
		mv php.ini.bak PHP/php.ini
	else
		cp PHP/php.ini-development PHP/php.ini

		echo '
; Dev customizations
post_max_size = 1G
extension_dir = "ext"
upload_max_filesize = 1G

extension=php_curl.dll
extension=php_fileinfo.dll
extension=php_gd2.dll
extension=php_mbstring.dll
extension=php_xsl.dll
extension=php_memcache.dll
extension=php_openssl.dll
zend_extension="php_xdebug.dll"

date.timezone = America/New_York
' >> PHP/php.ini
	fi

	chmod -R 755 PHP

	if [[ -d "${INSTALL_PATH}" ]]; then
		rm -rf "${INSTALL_PATH}"
	fi

	mv PHP "${INSTALL_PATH}"

	cleanup-download
}

function post-install () {
	# install composer to a local bin dir
	if [[ ! -x ~/bin/composer ]]; then
		curl -sS https://getcomposer.org/installer | php
		make-target ~/bin
		mv composer.phar ~/bin/composer
	else
		~/bin/composer self-update
	fi
}

function application-exists () {
	type php &> /dev/null && php -v &> /dev/null
}

function get-current-version () {
	if ! application-exists; then
		return
	fi
	php -r 'echo phpversion();'
}
