# shellcheck shell=bash

# @see https://www.mysql.com/
if ! command -v mysql &>/dev/null; then
  return
fi

# custom mysql prompt
MYSQL_PS1='\u@\h [\d]'$(echo -e "\xe2\x86\x92")' '
export MYSQL_PS1

# set pager for mysql client
alias mysql="mysql --line-numbers --pager='less -inSFX' --show-warnings --default-character-set=utf8"
