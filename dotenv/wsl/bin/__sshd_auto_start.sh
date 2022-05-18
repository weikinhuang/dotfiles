#!/usr/bin/env bash

if [[ -e /var/run/sshd.pid ]] && kill -0 "$(cat /var/run/sshd.pid)" &>/dev/null; then
  exit 0
fi

sudo rm -f /var/run/sshd.pid
sudo mkdir -p /run/sshd
exec sudo /usr/sbin/sshd -D
