# shellcheck shell=bash
# Number of threads that is available
PROC_CORES=$(/usr/sbin/sysctl -n hw.ncpu)
export PROC_CORES

# Hide the "default interactive shell is now zsh" warning on macOS.
export BASH_SILENCE_DEPRECATION_WARNING=1
