# shellcheck shell=bash
# Number of threads that is available
PROC_CORES=$(/usr/sbin/sysctl -n hw.ncpu)
export PROC_CORES
