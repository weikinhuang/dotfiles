# shellcheck shell=bash
# Configure Termux integration on Android.
# SPDX-License-Identifier: MIT

if ! command -v termux-setup-storage &>/dev/null; then
  return
fi

# Exported functions shadow the dotenv/linux/bin/ scripts that rely on
# tools unavailable on Termux (xclip, xdg-open, notify-send).

function pbcopy() { termux-clipboard-set "$@"; }
export -f pbcopy
function pbpaste() { termux-clipboard-get "$@"; }
export -f pbpaste

function open() {
  case "${1:-}" in
    -h | --help)
      cat <<'EOF'
Usage: open [PATH-OR-URL...]
Open files or URLs with the Android default handler via termux-open.

Options:
  -h, --help                  show this help and exit

All remaining arguments are forwarded to termux-open.
EOF
      return 0
      ;;
  esac
  termux-open "$@"
}
export -f open

function quick-toast() {
  case "${1:-}" in
    -h | --help)
      cat <<'EOF'
Usage: quick-toast [TITLE] [BODY]
Show an Android notification via termux-notification.

Options:
  -h, --help                  show this help and exit

If only BODY is provided, the default title is used.
Falls back to termux-toast, then a terminal bell.
Requires the Termux:API app and termux-api package.
EOF
      return 0
      ;;
  esac
  local title body
  if [[ $# -eq 0 ]]; then
    title="Terminal Notification"
    body="ALERT FROM TERMINAL"
  elif [[ $# -eq 1 ]]; then
    title="Terminal Notification"
    body="$1"
  else
    title="$1"
    body="$2"
  fi
  if command -v termux-notification &>/dev/null; then
    termux-notification --title "${title}" --content "${body}"
  elif command -v termux-toast &>/dev/null; then
    termux-toast "${title}: ${body}"
  else
    printf '\a'
  fi
}
export -f quick-toast

function keep-awake() {
  case "${1:-}" in
    -h | --help)
      cat <<'EOF'
Usage: keep-awake COMMAND [ARG...]
Run a command while holding an Android wake lock to prevent the
device from sleeping.

Options:
  -h, --help                  show this help and exit
EOF
      return 0
      ;;
  esac
  if [[ $# -eq 0 ]]; then
    echo "keep-awake: missing command" >&2
    return 1
  fi
  if ! command -v termux-wake-lock &>/dev/null; then
    "$@"
    return
  fi
  termux-wake-lock
  local rc=0
  "$@" || rc=$?
  termux-wake-unlock
  return $rc
}
export -f keep-awake

function termux-sshd() {
  case "${1:-}" in
    -h | --help)
      cat <<'EOF'
Usage: termux-sshd [start|stop|status]
Manage the Termux sshd server (port 8022).

Options:
  -h, --help                  show this help and exit
EOF
      return 0
      ;;
    stop)
      pkill sshd && echo "sshd stopped" || echo "sshd is not running" >&2
      ;;
    status)
      if pgrep -x sshd &>/dev/null; then
        echo "sshd is running"
        echo "  port: 8022"
        local ip
        ip=$(ip -4 addr show 2>/dev/null | awk '/inet / && !/127\.0\.0\.1/ {gsub(/\/.*/, "", $2); print $2; exit}')
        [[ -n "${ip}" ]] && echo "  connect: ssh $(whoami)@${ip} -p 8022"
      else
        echo "sshd is not running"
      fi
      ;;
    start | "")
      sshd
      termux-sshd status
      ;;
    *)
      echo "termux-sshd: unknown action: $1" >&2
      return 1
      ;;
  esac
}
export -f termux-sshd

# Storage shortcuts (available after termux-setup-storage grants permission)
if [[ -d "${HOME}/storage" ]]; then
  alias sdcard='cd ~/storage/shared'
  alias dl='cd ~/storage/downloads'
fi
