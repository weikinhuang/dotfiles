# shellcheck shell=bash
# Number of threads that is available
PROC_CORES=$(grep "^processor" -c /proc/cpuinfo)
export PROC_CORES
