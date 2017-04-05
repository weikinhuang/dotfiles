# Shortcuts to the clipboard
alias pbcopy="xclip -selection clipboard"
alias pbpaste="xclip -selection clipboard -o"

# open command shortcuts
if type xdg-open &> /dev/null; then
	alias open="xdg-open"
elif type gnome-open &> /dev/null; then
	alias open="gnome-open"
else
	alias open="nautilus"
fi

# useful shortcuts
alias md5="md5sum"

# Alias vi to vim
if type vim &> /dev/null; then
	alias vi="vim"
fi

# Alias clamscan with avscan
if type clamscan &> /dev/null; then
	alias avscan="clamscan"
fi

# Networking shortcuts
alias ips="ip addr | grep 'inet\>' | perl -nle'/(\d+\.\d+\.\d+\.\d+)/ && print \$1'"
