# shellcheck shell=bash
# function to get cpu load
if [[ -r /proc/loadavg ]]; then
  function __ps1_proc_use() {
    local loadavg
    read -r loadavg _ < /proc/loadavg
    echo -n "${loadavg}"
  }
else
  function __ps1_proc_use() {
    echo -n "$(uptime | awk '{print $(NF-2)}' | tr -d ',')"
  }
fi
