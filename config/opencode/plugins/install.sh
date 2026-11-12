#!/usr/bin/env bash
# Symlink the dotfiles opencode plugins into an opencode plugins directory.
# SPDX-License-Identifier: MIT

set -euo pipefail
IFS=$'\n\t'

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

function print_help() {
  cat <<'HELPDOC'
Usage: install.sh [OPTION]... [PLUGIN]...
Symlink dotfiles opencode plugins into an opencode plugins directory, one link
per plugin, so other plugins can live next to them. With no PLUGIN, every
plugin in config/opencode/plugins/ is selected.

Options:
  -d, --dir DIR         plugins directory to manage (default:
                        ${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-~/.config}/opencode}/plugins)
      --dir=DIR         set the plugins directory inline
  -p, --profile NAME    use the `opencode -u NAME` profile's plugins directory
                        (${XDG_CONFIG_HOME:-~/.config}/opencode-NAME/plugins)
      --profile=NAME    set the profile inline
  -f, --force           replace an existing symlink that points elsewhere
                        (real files and directories are never replaced)
  -u, --uninstall       remove the selected plugins' symlinks (only links
                        that point into this repo)
  -l, --list            show each plugin and whether it is installed
  -h, --help            display this help and exit

Restart opencode afterwards (`opencode service restart` for the background
service) so it picks up the change.
HELPDOC
}

function die() {
  echo "install.sh: $*" >&2
  exit 1
}

# Plugin directories: any child holding a server or TUI entry point.
function available_plugins() {
  local dir
  for dir in "${PLUGIN_ROOT}"/*/; do
    dir="${dir%/}"
    if [[ -f "${dir}/server.ts" || -f "${dir}/tui.tsx" ]]; then
      basename "${dir}"
    fi
  done
}

# True when LINK is a symlink to the plugin directory SOURCE.
function links_to() {
  local link="$1" source="$2"
  [[ -L "${link}" ]] || return 1
  [[ "$(readlink "${link}")" == "${source}" ]] && return 0
  [[ -d "${link}" ]] && [[ "$(cd -P "${link}" && pwd)" == "$(cd -P "${source}" && pwd)" ]]
}

TARGET_DIR=
PROFILE=
FORCE=
MODE=install
SELECTED=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      print_help
      exit 0
      ;;
    -d | --dir | -p | --profile)
      [[ $# -ge 2 ]] || die "missing value for $1"
      case "$1" in
        -d | --dir) TARGET_DIR="$2" ;;
        *) PROFILE="$2" ;;
      esac
      shift
      ;;
    --dir=*)
      TARGET_DIR="${1#*=}"
      ;;
    --profile=*)
      PROFILE="${1#*=}"
      ;;
    -f | --force)
      FORCE=1
      ;;
    -u | --uninstall)
      MODE=uninstall
      ;;
    -l | --list)
      MODE=list
      ;;
    -*)
      die "unknown argument: $1"
      ;;
    *)
      SELECTED+=("$1")
      ;;
  esac
  shift
done

[[ -z "${TARGET_DIR}" || -z "${PROFILE}" ]] || die "--dir and --profile are mutually exclusive"
if [[ -n "${PROFILE}" ]]; then
  [[ "${PROFILE}" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid profile name: ${PROFILE}"
  TARGET_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/opencode-${PROFILE}/plugins"
elif [[ -z "${TARGET_DIR}" ]]; then
  TARGET_DIR="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-${HOME}/.config}/opencode}/plugins"
fi

mapfile -t AVAILABLE < <(available_plugins)
if [[ ${#SELECTED[@]} -eq 0 ]]; then
  SELECTED=("${AVAILABLE[@]}")
else
  for name in "${SELECTED[@]}"; do
    if ! printf '%s\n' "${AVAILABLE[@]}" | grep -qxF -- "${name}"; then
      die "unknown plugin: ${name} (available: $(IFS=' ' && echo "${AVAILABLE[*]}"))"
    fi
  done
fi

STATUS=0
CHANGED=
for name in "${SELECTED[@]}"; do
  source="${PLUGIN_ROOT}/${name}"
  link="${TARGET_DIR}/${name}"
  case "${MODE}" in
    list)
      if links_to "${link}" "${source}"; then
        echo "${name}: installed"
      elif [[ -L "${link}" ]]; then
        echo "${name}: other symlink -> $(readlink "${link}")"
      elif [[ -e "${link}" ]]; then
        echo "${name}: blocked by an existing file or directory"
      else
        echo "${name}: not installed"
      fi
      ;;
    install)
      if links_to "${link}" "${source}"; then
        echo "${name}: already installed"
        continue
      fi
      if [[ -L "${link}" && -z "${FORCE}" ]]; then
        echo "install.sh: ${link} already links to $(readlink "${link}"); use --force to replace it" >&2
        STATUS=1
        continue
      fi
      if [[ -e "${link}" && ! -L "${link}" ]]; then
        echo "install.sh: ${link} exists and is not a symlink; leaving it alone" >&2
        STATUS=1
        continue
      fi
      mkdir -p "${TARGET_DIR}"
      ln -sfn "${source}" "${link}"
      echo "${name}: installed -> ${link}"
      CHANGED=1
      ;;
    uninstall)
      if links_to "${link}" "${source}"; then
        rm "${link}"
        echo "${name}: removed"
        CHANGED=1
      elif [[ -e "${link}" || -L "${link}" ]]; then
        echo "install.sh: ${link} is not a link to this repo's plugin; leaving it alone" >&2
        STATUS=1
      else
        echo "${name}: not installed"
      fi
      ;;
  esac
done

if [[ -n "${CHANGED}" ]]; then
  echo "Restart opencode to apply: opencode service restart"
fi
exit "${STATUS}"
