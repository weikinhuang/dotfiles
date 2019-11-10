# shellcheck shell=bash
# function to get cpu load
function __ps1_proc_use() {
  echo -n "$(/usr/bin/uptime | \sed 's/^..*: //' | \cut -d' ' -f1)"
}
