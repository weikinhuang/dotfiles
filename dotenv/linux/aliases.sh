# shellcheck shell=bash
# Shortcuts to the clipboard
alias pbcopy="xclip -selection clipboard"
alias pbpaste="xclip -selection clipboard -o"

# open command shortcuts
if command -v xdg-open &>/dev/null; then
  alias open="xdg-open"
elif command -v gnome-open &>/dev/null; then
  alias open="gnome-open"
else
  alias open="nautilus"
fi

# Alias vi to vim
if command -v vim &>/dev/null; then
  alias vi="vim"
fi

# Networking shortcuts
function ips() {
  ip addr | grep 'inet\>' | perl -nle'/(\d+\.\d+\.\d+\.\d+)/ && print $1'
}
