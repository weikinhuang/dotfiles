# shellcheck shell=bash
# Bash completion for ai-fetch-web.
# SPDX-License-Identifier: MIT

_dot_ai_fetch_web() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD - 1]}"

  # Flags that take a free-form value: don't suggest anything.
  case "${prev}" in
    --limit | --engines | --categories | --format | --renderer | \
      --timeout-ms | --html-file | --base-url | \
      --fields | --fields-file | -o | --output)
      return
      ;;
  esac

  # Find the subcommand (first non-flag word after the program name).
  local i op=""
  for ((i = 1; i < COMP_CWORD; i++)); do
    local w="${COMP_WORDS[i]}"
    case "${w}" in
      -*) continue ;;
      *)
        op="${w}"
        break
        ;;
    esac
  done

  # No subcommand yet: complete subcommand names and global flags.
  if [[ -z "${op}" ]]; then
    if [[ "${cur}" == -* ]]; then
      mapfile -t COMPREPLY < <(compgen -W "--json --timeout-ms -v --verbose -q --quiet -h --help" -- "${cur}")
    else
      mapfile -t COMPREPLY < <(compgen -W "search fetch fetch-many convert links extract metadata screenshot defaults help" -- "${cur}")
    fi
    return
  fi

  # Per-subcommand flag completion. Non-flag words (URLs, queries,
  # filenames) fall through to default file completion where useful.
  if [[ "${cur}" == -* ]]; then
    local flags=""
    case "${op}" in
      search) flags="--limit --engines --categories --json -h --help" ;;
      fetch) flags="--format --renderer --raw --json -h --help" ;;
      fetch-many) flags="--format --renderer --raw --json -h --help" ;;
      convert) flags="--html-file --base-url --format --raw --json -h --help" ;;
      links) flags="--raw --json -h --help" ;;
      extract) flags="--fields --fields-file --raw --json -h --help" ;;
      metadata) flags="--raw --json -h --help" ;;
      screenshot) flags="-o --output --json -h --help" ;;
      defaults) flags="--json -h --help" ;;
      *) return ;;
    esac
    mapfile -t COMPREPLY < <(compgen -W "${flags}" -- "${cur}")
    return
  fi

  # Default: file completion for convert --html-file and extract --fields-file
  # (already handled above). For `screenshot -o`, also file completion.
  compopt -o default 2>/dev/null || true
  COMPREPLY=()
}
complete -F _dot_ai_fetch_web ai-fetch-web
