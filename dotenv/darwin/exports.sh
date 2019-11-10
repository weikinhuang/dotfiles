# shellcheck shell=bash
# Number of threads that is available
export PROC_CORES=$(/usr/sbin/sysctl -n hw.ncpu)
