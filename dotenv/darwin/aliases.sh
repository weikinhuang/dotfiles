# Shortcuts

# Alias vi to vim
if type vim &> /dev/null; then
	alias vi="vim"
fi

# Alias clamscan with avscan
if type clamscan &> /dev/null; then
	alias avscan="clamscan"
fi

# Networking shortcuts
alias ips="ifconfig | grep 'inet\>' | perl -nle'/(\d+\.\d+\.\d+\.\d+)/ && print \$1'"
