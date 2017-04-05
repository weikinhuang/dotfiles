# Easier navigation: .., ..., ~ and -
alias ..="cd .."
alias ...="cd ../.."
alias ....="cd ../../.."
alias ~="cd ~"
alias -- -="cd -"

# Shortcuts

# useful shortcuts
alias h="history"
alias f="findhere"
alias o="open"
alias oo="open ."

# common folder shortcuts
alias p="cd '${PROJECT_DIR-$HOME}"

# cd replacement to show cd history with cd --
alias cd="__cd_func"

# Interactive rm, cp, and mv
alias rm="rm -i"
alias cp="cp -i"
alias mv="mv -i"

# Colorize grep matches
# test if color is supported
echo | grep --color=auto > /dev/null 2>&1
# if it is, always add color
if [[ $? == 0 ]]; then
	alias grep="grep --color=auto"
	alias fgrep="fgrep --color=auto"
	alias egrep="egrep --color=auto"
fi

# Detect which `ls` flavor is in use
if ls --color > /dev/null 2>&1; then
	# GNU ls
	LS_COLOR_FLAG="--color=auto"
else
	# darwin ls
	LS_COLOR_FLAG="-G"
fi
# Specialized directory listings
alias la="ls -lA ${LS_COLOR_FLAG}"
alias ll="ls -l ${LS_COLOR_FLAG}"
alias l.="ls -d ${LS_COLOR_FLAG} .*"
alias ls="ls ${LS_COLOR_FLAG}"
alias lf="ls -l ${LS_COLOR_FLAG} | grep '^d'"

# check if we can display in long format
if ls --format=long > /dev/null 2>&1; then
	alias dir="ls ${LS_COLOR_FLAG} --format=vertical"
	alias vdir="ls ${LS_COLOR_FLAG} --format=long"
fi

unset LS_COLOR_FLAG

# allow which command to expand
if which --tty-only which > /dev/null 2>&1; then
	alias which="alias | /usr/bin/which --tty-only --read-alias --show-dot --show-tilde"
fi

# shortcut to parallel-xargs
alias x="parallel-xargs"

# alias for date conversion
alias totime="date2unix"
alias fromtime="unix2date"

# Enable aliases to be sudo'ed
alias sudo="sudo "

# Make 'less' not clear the screen upon exit and process colors
alias less="less -XR"

# Networking shortcuts
alias extip="curl -s http://whatismyip.akamai.com/ | sed 's/[^0-9\.]//g'"

# shortcuts to restful style curl requests
for method in GET HEAD POST PUT DELETE TRACE OPTIONS; do
	alias "$method"="__request body $method"
	alias "h$method"="__request headers $method"
done
unset $method
