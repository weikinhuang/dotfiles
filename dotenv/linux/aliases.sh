# shellcheck shell=bash

# Alias vi to vim
if command -v vim &>/dev/null; then
  alias vi="vim"
fi

# Networking shortcuts
function ips() {
  ip addr | grep 'inet\>' | perl -nle'/(\d+\.\d+\.\d+\.\d+)/ && print $1'
}
