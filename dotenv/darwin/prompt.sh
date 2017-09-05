# function to get cpu load
function __ps1_proc_use() {
  echo -n "$(/usr/bin/uptime | \sed 's/^..*: //' | \cut -d' ' -f1)"
}

# function to test for docker
function __ps1_is_docker() {
  false
}
