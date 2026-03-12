# shellcheck shell=bash
# Export Linux-specific environment defaults.
# SPDX-License-Identifier: MIT

# Number of threads that is available
PROC_CORES=$(grep "^processor" -c /proc/cpuinfo)
export PROC_CORES
