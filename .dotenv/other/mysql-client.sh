# custom mysql prompt
export MYSQL_PS1='\u@\h [\d]'$(echo -e "\xe2\x86\x92")' '

# set pager for mysql client
alias mysql="mysql --line-numbers --pager='less -inSFX' --show-warnings --default-character-set=utf8"
