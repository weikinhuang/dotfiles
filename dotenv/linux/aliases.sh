# shellcheck shell=bash

# Networking shortcuts
function ips() {
  ip addr | grep 'inet\>' | perl -nle'/(\d+\.\d+\.\d+\.\d+)/ && print $1'
}
