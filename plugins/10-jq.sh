# shellcheck shell=bash
# Configure jq output defaults.
# SPDX-License-Identifier: MIT

# @see https://jqlang.github.io/jq/
if ! command -v jq &>/dev/null; then
  return
fi

# Themed jq output colors (null:false:true:number:string:array:object:key)
if [[ -z "${JQ_COLORS+x}" ]]; then
  export JQ_COLORS="0;90:0;31:0;32:0;33:0;36:1;35:1;35:1;34"
fi
