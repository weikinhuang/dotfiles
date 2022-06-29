# shellcheck shell=bash
# function to get cpu load
function __ps1_proc_use() {
  echo -n "$(/usr/sbin/sysctl -n vm.loadavg | \awk '{ print $2 }')"
}
