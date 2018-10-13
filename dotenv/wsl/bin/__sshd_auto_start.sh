#!/usr/bin/env bash

if [[ -e /var/run/sshd.pid ]]; then
  exit 0
fi

sudo mkdir -p /run/sshd
exec sudo /usr/sbin/sshd -D
