# function to get cpu load
function __ps1_proc_use() {
  echo -n "$(\sed -n "s/\([0-9]\.[0-9][0-9]\).\+/\1/p" /proc/loadavg)"
}
