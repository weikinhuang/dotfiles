# shellcheck shell=bash

# @see https://www.gnu.org/software/bash/manual/bash.html#The-Set-Builtin
if [[ -z "${DOT_BASH_RESOLVE_PATHS:-}" ]]; then
  return
fi

# same as -P
# If set, do not resolve symbolic links when performing commands such as cd which change the current directory. The physical
# directory is used instead. By default, Bash follows the logical chain of directories when performing commands which change
# the current directory.
set -o physical

unset DOT_BASH_RESOLVE_PATHS
