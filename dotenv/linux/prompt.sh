# function to get cpu load
function __ps1_proc_use() {
  echo -n "$(\sed -n "s/\([0-9]\.[0-9][0-9]\).\+/\1/p" /proc/loadavg)"
}

# function to test for docker
function __ps1_is_docker() {
  [ -f /.dockerenv ] || ! cat /proc/1/cgroup 2>/dev/null | grep -q '/$'
}
