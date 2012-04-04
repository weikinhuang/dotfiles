alias lf="ls -l --color=auto | grep '^d'" 2> /dev/null
alias la='ls -A --color=auto' 2> /dev/null
alias ll='ls -l --color=auto' 2> /dev/null
alias l.='ls -d .* --color=auto' 2> /dev/null
alias ls='ls --color=auto' 2> /dev/null

alias dir='ls --color=auto --format=vertical'
alias vdir='ls --color=auto --format=long'

alias rm='rm -i'
alias cp='cp -i'
alias mv='mv -i'

alias which='alias | /usr/bin/which --tty-only --read-alias --show-dot --show-tilde'

alias open='cygstart'

alias kill='/bin/kill.exe -f'

alias ps='ps -W'

alias vi='nppedit'

alias yum="apt-cyg"
