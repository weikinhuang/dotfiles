#!/bin/bash
#title              : __winsudoproxy.sh
#description        : Companion script for winsudo
#author             : Wei Kin Huang
#date               : 2018-10-13
#version            : 1.0.0
#usage              : __winsudoproxy.sh PORT
#requires           : sshd
#==============================================================================
set -euo pipefail
IFS=$'\n\t'

PARENT_PID_PORT="$1"
WINSUDO_WORKDIR="${HOME}/.ssh/winsudosshd"

# use preset config with a blank slate
# https://infosec.mozilla.org/guidelines/openssh
/usr/sbin/sshd -D \
  -f /dev/null \
  -p "${PARENT_PID_PORT}" \
  -o AuthenticationMethods=publickey \
  -o AuthorizedKeysFile="${WINSUDO_WORKDIR}/authorized_keys" \
  -o Ciphers="chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes128-gcm@openssh.com,aes256-ctr,aes192-ctr,aes128-ctr" \
  -o HostKey="${WINSUDO_WORKDIR}/ssh_host_ed25519_key" \
  -o KexAlgorithms="curve25519-sha256@libssh.org,ecdh-sha2-nistp521,ecdh-sha2-nistp384,ecdh-sha2-nistp256,diffie-hellman-group-exchange-sha256" \
  -o ListenAddress=127.0.0.1 \
  -o MACs="hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com,umac-128-etm@openssh.com,hmac-sha2-512,hmac-sha2-256,umac-128@openssh.com" \
  -o MaxSessions=1 \
  -o PermitRootLogin=No \
  -o PidFile="${WINSUDO_WORKDIR}/winsudo.${PARENT_PID_PORT}.pid"
