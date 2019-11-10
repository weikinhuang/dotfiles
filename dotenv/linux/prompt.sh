# function to get cpu load
if [[ -r /proc/loadavg ]]; then
  function __ps1_proc_use() {
    echo -n "$(\sed -n "s/\([0-9]\.[0-9][0-9]\).\+/\1/p" /proc/loadavg)"
  }
else
  function __ps1_proc_use() {
    echo -n "$(uptime | rev | cut -d' ' -f 3 | rev | \sed -n "s/\([0-9]\.[0-9][0-9]\).\+/\1/p")"
  }
fi
