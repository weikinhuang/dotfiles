# shellcheck shell=bash

# @see https://www.docker.com/
if ! command -v docker &>/dev/null; then
  return
fi

# ignore additional commands in bash history
export HISTIGNORE="${HISTIGNORE}${HISTIGNORE+:}docker-compose up:docker-compose down:docker ps:docker ssh"

# Change the compose connection timeout, ex. logs won't continue tailing after 1 minute
# set this to 2h - default 60s
export COMPOSE_HTTP_TIMEOUT=7200
