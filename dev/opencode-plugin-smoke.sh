#!/usr/bin/env bash
# Live-test opencode plugins from config/opencode/plugins in a scratch project.
# SPDX-License-Identifier: MIT

set -euo pipefail
IFS=$'\n\t'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_ROOT="${REPO_ROOT}/config/opencode/plugins"
SCRATCH_PARENT="${OPENCODE_SMOKE_TMP:-/tmp}"
DEFAULT_MODEL="github-copilot/claude-haiku-5.5"
DEFAULT_CLI_CONFIG='{"highlights":false,"attention":{"notifications":false,"sound":false}}'

function print_help() {
  cat <<'HELPDOC'
Usage: dev/opencode-plugin-smoke.sh <command> [OPTION]... [ARG]...
Drive `opencode --standalone` in a detached tmux session against a scratch
project whose .opencode/plugins/ symlinks the selected repo plugins.

Commands:
  start [OPTION]... PLUGIN...   create /tmp/opencode-smoke-NAME and boot the TUI
  check [OPTION]... PLUGIN...   load-only: boot a private `opencode serve`,
                                print plugin load / error log lines, exit
  send NAME TEXT...             type TEXT literally into the TUI, then Enter
  keys NAME KEY...              raw `tmux send-keys` (Escape, C-c, Down, ...)
  capture NAME [LINES]          last LINES (default 20) non-blank pane lines
  wait NAME REGEX [SECONDS]     poll the pane until REGEX (grep -E) appears
                                (default 90s); exit 1 on timeout
  restart NAME [OPENCODE_ARG]...
                                relaunch the TUI in the kept scratch dir with
                                the same plugins, options, stubs, and env;
                                extra args go to opencode (e.g. --continue)
  dir NAME                      print the scratch directory
  stop NAME [--keep]            kill the tmux session and remove the scratch
                                directory (kept with --keep)

PLUGIN is a directory name under config/opencode/plugins/ or a path to a
plugin directory or .ts/.js file.

Options for start / check:
  -n, --name NAME          session + scratch name (default: ocsmoke)
  -m, --model MODEL        provider/model for the scratch config
                           (default: github-copilot/claude-haiku-5.5)
  -o, --options P=JSON     plugin options for plugin P (repeatable); adds a
                           {"package": "./plugins/P", "options": JSON} entry
  -s, --stub CMD           put a stub CMD first on PATH that appends its argv
                           to <scratch>/stub-CMD.log (repeatable)
  -e, --env KEY=VALUE      extra environment for opencode (repeatable)
      --size WxH           tmux pane size (default: 120x30)
      --cli-config JSON    OPENCODE_CLI_CONFIG_CONTENT for the TUI (default
                           disables highlights and native attention pings)
  -h, --help               display this help and exit

Long options also accept --flag=value. Sessions and credentials come from the
default opencode data dir; ~/.config/opencode is read but never written.
HELPDOC
}

function die() {
  echo "opencode-plugin-smoke: $*" >&2
  exit 1
}

function scratch_dir() {
  [[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] || die "invalid name: $1"
  echo "${SCRATCH_PARENT}/opencode-smoke-$1"
}

function resolve_plugin() {
  local spec="$1"
  if [[ -e "${spec}" ]]; then
    (cd "$(dirname "${spec}")" && echo "$(pwd)/$(basename "${spec}")")
  elif [[ -e "${PLUGIN_ROOT}/${spec}" ]]; then
    echo "${PLUGIN_ROOT}/${spec}"
  else
    die "plugin not found: ${spec}"
  fi
}

NAME=ocsmoke
MODEL="${DEFAULT_MODEL}"
SIZE=120x30
CLI_CONFIG="${DEFAULT_CLI_CONFIG}"
PLUGINS=()
OPTIONS=()
STUBS=()
EXTRA_ENV=()

function parse_setup_args() {
  local value
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h | --help)
        print_help
        exit 0
        ;;
      -n | --name | -m | --model | -o | --options | -s | --stub | -e | --env | --size | --cli-config)
        [[ $# -ge 2 ]] || die "missing value for $1"
        set_setup_option "$1" "$2"
        shift
        ;;
      --name=* | --model=* | --options=* | --stub=* | --env=* | --size=* | --cli-config=*)
        value="${1#*=}"
        set_setup_option "${1%%=*}" "${value}"
        ;;
      -*)
        die "unknown argument: $1"
        ;;
      *)
        PLUGINS+=("$1")
        ;;
    esac
    shift
  done
  [[ ${#PLUGINS[@]} -gt 0 ]] || die "no plugins given"
}

function set_setup_option() {
  case "$1" in
    -n | --name) NAME="$2" ;;
    -m | --model) MODEL="$2" ;;
    -o | --options) OPTIONS+=("$2") ;;
    -s | --stub) STUBS+=("$2") ;;
    -e | --env) EXTRA_ENV+=("$2") ;;
    --size) SIZE="$2" ;;
    --cli-config) CLI_CONFIG="$2" ;;
  esac
}

# Create the scratch project: git repo, plugin symlinks, config, stubs.
function prepare_scratch() {
  local dir="$1" plugin target entry stub opt name json first=1
  [[ ! -e "${dir}" ]] || die "${dir} already exists; run: $0 stop ${NAME}"
  mkdir -p "${dir}/.opencode/plugins" "${dir}/bin"
  git -C "${dir}" init -q
  for plugin in "${PLUGINS[@]}"; do
    target="$(resolve_plugin "${plugin}")"
    ln -s "${target}" "${dir}/.opencode/plugins/$(basename "${target}")"
  done
  {
    # shellcheck disable=SC2016 # literal "$schema" JSON key
    printf '{\n  "$schema": "https://opencode.ai/config.json",\n  "model": "%s",\n  "plugins": [' "${MODEL}"
    for opt in "${OPTIONS[@]+"${OPTIONS[@]}"}"; do
      name="${opt%%=*}"
      json="${opt#*=}"
      [[ "${name}" != "${opt}" ]] || die "--options needs PLUGIN=JSON: ${opt}"
      [[ -e "${dir}/.opencode/plugins/${name}" ]] || die "--options for unselected plugin: ${name}"
      entry="$(printf '{ "package": "./plugins/%s", "options": %s }' "${name}" "${json}")"
      [[ -n "${first}" ]] || printf ','
      printf '\n    %s' "${entry}"
      first=
    done
    printf '\n  ]\n}\n'
  } >"${dir}/.opencode/opencode.jsonc"
  for stub in "${STUBS[@]+"${STUBS[@]}"}"; do
    [[ "${stub}" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid stub name: ${stub}"
    cat >"${dir}/bin/${stub}" <<STUB
#!/usr/bin/env bash
{ printf '%s' "\$(date +%s)"; printf ' %q' "\$@"; printf '\n'; } >>'${dir}/stub-${stub}.log'
STUB
    chmod +x "${dir}/bin/${stub}"
  done
}

function opencode_env() {
  local dir="$1"
  printf '%s\n' "PATH=${dir}/bin:${PATH}" "OPENCODE_CLI_CONFIG_CONTENT=${CLI_CONFIG}"
  [[ ${#EXTRA_ENV[@]} -eq 0 ]] || printf '%s\n' "${EXTRA_ENV[@]}"
}

# Boot the TUI in tmux from the launch file `start` wrote: line 1 is the pane
# size, the rest is the opencode environment. Extra args go to opencode.
function launch_tui() {
  local name="$1" dir="$2" opencode_bin size waited=0
  shift 2
  opencode_bin="$(command -v opencode)" || die "opencode not on PATH"
  tmux has-session -t "${name}" 2>/dev/null && die "tmux session ${name} already exists"
  [[ -f "${dir}/.smoke-launch" ]] || die "no launch file in ${dir}; run: $0 start"
  local -a launch
  mapfile -t launch <"${dir}/.smoke-launch"
  size="${launch[0]}"
  # Keep the pane open after opencode exits so the exit status stays readable.
  # shellcheck disable=SC2016 # expanded by the inner bash
  tmux new-session -d -s "${name}" -x "${size%x*}" -y "${size#*x}" -c "${dir}" -- \
    env "${launch[@]:1}" bash -c '"$0" --standalone "${@}"; echo "[opencode exited: $?]"; read -r _' \
    "${opencode_bin}" "$@"
  # The first `send` is lost if it arrives before the prompt renders.
  until tmux capture-pane -t "${name}" -p | grep -q 'ctrl+p'; do
    if [[ ${waited} -ge 30 ]]; then
      echo "opencode-plugin-smoke: TUI not ready after 30s; check: $0 capture ${name}" >&2
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

function cmd_start() {
  parse_setup_args "$@"
  local dir
  dir="$(scratch_dir "${NAME}")"
  tmux has-session -t "${NAME}" 2>/dev/null && die "tmux session ${NAME} already exists"
  prepare_scratch "${dir}"
  { echo "${SIZE}" && opencode_env "${dir}"; } >"${dir}/.smoke-launch"
  launch_tui "${NAME}" "${dir}"
  echo "started tmux session ${NAME} in ${dir}"
}

function cmd_restart() {
  [[ $# -ge 1 ]] || die "usage: restart NAME [OPENCODE_ARG]..."
  local name="$1" dir
  shift
  dir="$(scratch_dir "${name}")"
  [[ -d "${dir}" ]] || die "${dir} does not exist; run: $0 start -n ${name} PLUGIN..."
  tmux kill-session -t "${name}" 2>/dev/null || true
  launch_tui "${name}" "${dir}" "$@"
  echo "restarted tmux session ${name} in ${dir}"
}

function cmd_check() {
  parse_setup_args "$@"
  local dir opencode_bin port password log pid
  dir="$(scratch_dir "${NAME}-check")"
  opencode_bin="$(command -v opencode)" || die "opencode not on PATH"
  prepare_scratch "${dir}"
  port=$((50000 + RANDOM % 10000))
  password="smoke-${RANDOM}${RANDOM}"
  log="${dir}/serve.log"
  local -a env_args
  mapfile -t env_args < <(opencode_env "${dir}")
  (cd "${dir}" && exec env "${env_args[@]}" OPENCODE_PASSWORD="${password}" \
    "${opencode_bin}" serve --hostname 127.0.0.1 --port "${port}" --print-logs >"${log}" 2>&1) &
  pid=$!
  # A request from the scratch dir boots that location (the client's cwd picks
  # it), which loads the location's plugins.
  local i
  for i in $(seq 1 30); do
    if (cd "${dir}" && OPENCODE_PASSWORD="${password}" "${opencode_bin}" --server "http://127.0.0.1:${port}" plugin list) >/dev/null 2>&1; then
      break
    fi
    [[ ${i} -lt 30 ]] || echo "opencode-plugin-smoke: server did not answer" >&2
    sleep 1
  done
  sleep 2
  kill "${pid}" 2>/dev/null || true
  wait "${pid}" 2>/dev/null || true
  grep -E 'loading plugin|level=(ERROR|WARN)' "${log}" | grep -vE 'models-dev|provider' || true
  local status=0
  grep -q 'failed to load plugin' "${log}" && status=1
  rm -rf "${dir}"
  return "${status}"
}

function cmd_send() {
  [[ $# -ge 2 ]] || die "usage: send NAME TEXT..."
  local name="$1"
  shift
  tmux send-keys -t "${name}" -l "$*"
  tmux send-keys -t "${name}" Enter
}

function cmd_keys() {
  [[ $# -ge 2 ]] || die "usage: keys NAME KEY..."
  tmux send-keys -t "$@"
}

function cmd_capture() {
  [[ $# -ge 1 ]] || die "usage: capture NAME [LINES]"
  tmux capture-pane -t "$1" -p | grep -vE '^\s*$' | tail -n "${2:-20}"
}

function cmd_wait() {
  [[ $# -ge 2 ]] || die "usage: wait NAME REGEX [SECONDS]"
  local name="$1" pattern="$2" timeout="${3:-90}" waited=0
  while ! tmux capture-pane -t "${name}" -p | grep -qE "${pattern}"; do
    if [[ ${waited} -ge ${timeout} ]]; then
      echo "timeout waiting for /${pattern}/" >&2
      return 1
    fi
    sleep 2
    waited=$((waited + 2))
  done
  echo "matched /${pattern}/ after ~${waited}s"
}

function cmd_stop() {
  [[ $# -ge 1 ]] || die "usage: stop NAME [--keep]"
  local dir
  dir="$(scratch_dir "$1")"
  tmux kill-session -t "$1" 2>/dev/null || true
  if [[ "${2:-}" == "--keep" ]]; then
    echo "kept ${dir}"
  elif [[ -d "${dir}" ]]; then
    rm -rf "${dir}"
  fi
}

function main() {
  [[ $# -ge 1 ]] || {
    print_help >&2
    exit 1
  }
  local cmd="$1"
  shift
  case "${cmd}" in
    -h | --help)
      print_help
      exit 0
      ;;
    start) cmd_start "$@" ;;
    restart) cmd_restart "$@" ;;
    check) cmd_check "$@" ;;
    send) cmd_send "$@" ;;
    keys) cmd_keys "$@" ;;
    capture) cmd_capture "$@" ;;
    wait) cmd_wait "$@" ;;
    dir) scratch_dir "${1:?usage: dir NAME}" ;;
    stop) cmd_stop "$@" ;;
    *) die "unknown command: ${cmd}" ;;
  esac
}

main "$@"
