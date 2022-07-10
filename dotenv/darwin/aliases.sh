# shellcheck shell=bash
# Shortcuts

# Networking shortcuts
function ips() {
  ifconfig | grep 'inet\>' | perl -nle'/(\d+\.\d+\.\d+\.\d+)/ && print $1'
}
