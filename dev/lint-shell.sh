#!/usr/bin/env bash
# Run shellcheck and shfmt on tracked shell files.
# SPDX-License-Identifier: MIT

set -euo pipefail
IFS=$'\n\t'

SHELLCHECK_VERSION=0.11.0
SHFMT_VERSION=3.13.1
# default: one job per CPU, capped at 8 (~80MB per shellcheck process)
JOBS="${LINT_SHELL_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"

FIX=
TARGETS=()

print_help() {
  cat <<'EOF'
Usage: dev/lint-shell.sh [OPTION]... [FILE]...
Run shellcheck + shfmt on tracked shell and bats files.
With FILE arguments, only the given files that are tracked shell or bats files
are checked (paths may be absolute or relative to the current directory).

Options:
  -f, --fix     rewrite files in place to match shfmt style (default: diff only)
  -h, --help    display this help and exit

Environment:
  LINT_SHELL_JOBS  shellcheck processes or containers to run at once
                   (default: number of CPUs, at most 8)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -f | --fix)
      FIX=1
      ;;
    -h | --help)
      print_help
      exit 0
      ;;
    --)
      shift
      TARGETS+=("$@")
      break
      ;;
    -*)
      echo "lint-shell.sh: unknown argument: $1" >&2
      print_help >&2
      exit 1
      ;;
    *)
      TARGETS+=("$1")
      ;;
  esac
  shift
done

if ! [[ "${JOBS}" =~ ^[1-9][0-9]*$ ]]; then
  echo "lint-shell.sh: LINT_SHELL_JOBS must be a positive integer: ${JOBS}" >&2
  exit 1
fi
if [[ -z "${LINT_SHELL_JOBS:-}" && "${JOBS}" -gt 8 ]]; then
  JOBS=8
fi

ROOT="$(git rev-parse --show-toplevel)"

# git ls-files output is repo-relative. lint-staged passes absolute paths under
# ROOT; anything else (relative, `..`, symlinked dirs) is resolved physically.
for i in "${!TARGETS[@]}"; do
  t="${TARGETS[i]}"
  if [[ "${t}" != "${ROOT}"/* && -d "$(dirname -- "${t}")" ]]; then
    t="$(CDPATH='' cd -- "$(dirname -- "${t}")" && pwd -P)/$(basename -- "${t}")"
  fi
  TARGETS[i]="${t#"${ROOT}/"}"
done

cd "${ROOT}"

SHFMT_MODE=(-d)
if [[ -n "${FIX}" ]]; then
  SHFMT_MODE=(-w)
fi

# keep only the requested FILE arguments, or pass everything through when none were given
filter_targets() {
  if [[ ${#TARGETS[@]} -eq 0 ]]; then
    cat
  else
    grep -Fx -f <(printf '%s\n' "${TARGETS[@]}") || true
  fi
}

# tracked files still present in the work tree, narrowed to FILE arguments
# before anything reads file contents so hook runs stay cheap
get_candidates() {
  # uniq: unmerged paths are listed once per conflict stage
  git ls-files \
    | uniq \
    | grep -vFx -f <(git ls-files -d) \
    | filter_targets \
    | grep -v -e 'external/' -e '\.md$' -e '\.gitlab-ci\.yml$' \
    || true
}

# split candidates into bats files and shell files (*.sh, or a shell shebang /
# `# shellcheck shell=` directive)
SHELL_FILES=()
BATS_FILES=()
collect_files() {
  local f shell=() others=()
  while IFS= read -r f; do
    case "${f}" in
      *.bats) BATS_FILES+=("${f}") ;;
      *.sh) shell+=("${f}") ;;
      *) others+=("${f}") ;;
    esac
  done < <(get_candidates)
  if [[ ${#others[@]} -gt 0 ]]; then
    while IFS= read -r f; do
      shell+=("${f}")
    done < <(printf '%s\0' "${others[@]}" | xargs -0 grep -l 'shellcheck shell=\|^#!.\+sh' 2>/dev/null || true)
  fi
  if [[ ${#shell[@]} -gt 0 ]]; then
    while IFS= read -r f; do
      SHELL_FILES+=("${f}")
    done < <(printf '%s\n' "${shell[@]}" | LC_ALL=C sort)
  fi
}

# run CMD... -- FILE... in JOBS parallel workers. Batches are at most
# BATCH_SIZE files so local workers finish together; with BATCH_SIZE=0 the
# files are split into exactly JOBS batches, so Docker starts JOBS containers
# instead of one per file.
run_batched() {
  local cmd=()
  while [[ "$1" != -- ]]; do
    cmd+=("$1")
    shift
  done
  shift
  [[ $# -gt 0 ]] || return 0
  local n=$((($# + JOBS - 1) / JOBS))
  if [[ "${BATCH_SIZE}" -gt 0 && "${n}" -gt "${BATCH_SIZE}" ]]; then
    n="${BATCH_SIZE}"
  fi
  printf '%s\0' "$@" | xargs -0 -n "${n}" -P "${JOBS}" "${cmd[@]}"
}

# true when `$1 --version` reports exactly version $2 (shellcheck prints a
# `version: X` line; shfmt prints `vX` or `X` depending on the build)
has_version() {
  local out
  command -v "$1" &>/dev/null || return 1
  out="$("$1" --version 2>/dev/null)" || return 1
  [[ $'\n'"${out}"$'\n' == *$'\n'"version: $2"$'\n'* || "${out}" == "v$2" || "${out}" == "$2" ]]
}

collect_files
if [[ ${#TARGETS[@]} -gt 0 && ${#SHELL_FILES[@]} -eq 0 && ${#BATS_FILES[@]} -eq 0 ]]; then
  exit 0
fi

# A local tool at the pinned version skips the container start (~1-4s each on
# Docker Desktop); without one, fall back to the pinned image.
DOCKER_ARGS=(-i --rm -u "$(id -u):$(id -g)" --read-only --cap-drop all -v "${PWD}:/mnt" -w /mnt)
SHELLCHECK=(docker run "${DOCKER_ARGS[@]}" "koalaman/shellcheck:v${SHELLCHECK_VERSION}")
BATCH_SIZE=0
if has_version shellcheck "${SHELLCHECK_VERSION}"; then
  SHELLCHECK=(shellcheck)
  BATCH_SIZE=8
fi
SHFMT=(docker run "${DOCKER_ARGS[@]}" "mvdan/shfmt:v${SHFMT_VERSION}")
if has_version shfmt "${SHFMT_VERSION}"; then
  SHFMT=(shfmt)
fi

# every phase runs even after an earlier one fails, so one pass reports
# (and with -f, fixes) everything
STATUS=0

echo "==> Running shellcheck..."
if [[ ${#SHELL_FILES[@]} -gt 0 ]]; then
  run_batched "${SHELLCHECK[@]}" -f gcc --source-path=SCRIPTDIR -- "${SHELL_FILES[@]}" || STATUS=1
fi
# --norc disables .shellcheckrc (external-sources=true) for bats files.
# Without this, shellcheck 0.11 follows each `source "${REPO_ROOT}/..."` inside
# every `@test` block and consumes 10GB+ per file.
if [[ ${#BATS_FILES[@]} -gt 0 ]]; then
  run_batched "${SHELLCHECK[@]}" --norc -S warning -s bats -f gcc -- "${BATS_FILES[@]}" || STATUS=1
fi

# shfmt runs serially so diffs from different files never interleave
echo "==> Running shfmt..."
if [[ ${#SHELL_FILES[@]} -gt 0 ]]; then
  printf '%s\0' "${SHELL_FILES[@]}" | xargs -0 "${SHFMT[@]}" -ln bash -ci -bn -i 2 "${SHFMT_MODE[@]}" || STATUS=1
fi

echo "==> Running shfmt on bats files..."
if [[ ${#BATS_FILES[@]} -gt 0 ]]; then
  printf '%s\0' "${BATS_FILES[@]}" | xargs -0 "${SHFMT[@]}" -ln bats -ci -bn -i 2 "${SHFMT_MODE[@]}" || STATUS=1
fi

if [[ "${STATUS}" -ne 0 ]]; then
  exit 1
fi
echo "OK"
