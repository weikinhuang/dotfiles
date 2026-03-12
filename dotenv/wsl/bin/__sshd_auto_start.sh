#!/usr/bin/env bash

function print_help() {
  cat <<'EOF'
Usage: __sshd_auto_start.sh [OPTION]...
Start sshd under sudo when it is not already running.

Options:
  -h, --help                  show this help and exit
EOF
}

case "${1:-}" in
  -h | --help)
    print_help
    exit 0
    ;;
esac

if [[ -e /var/run/sshd.pid ]] && kill -0 "$(cat /var/run/sshd.pid)" &>/dev/null; then
  exit 0
fi

sudo rm -f /var/run/sshd.pid
sudo mkdir -p /run/sshd
exec sudo /usr/sbin/sshd -D
