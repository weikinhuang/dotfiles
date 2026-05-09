#!/usr/bin/env bats
# Tests for dotenv/bin/ai-skill-eval.
# SPDX-License-Identifier: MIT

setup() {
  load '../../helpers/common'
  setup_test_bin
  setup_isolated_home
  SCRIPT="${REPO_ROOT}/dotenv/bin/ai-skill-eval"

  # Isolated project for discovery tests.
  PROJECT="${BATS_TEST_TMPDIR}/project"
  mkdir -p "${PROJECT}"
  cd "${PROJECT}" || exit 1
}

# ──────────────────────────────────────────────────────────────────
# Fixture helpers
# ──────────────────────────────────────────────────────────────────

make_skill() {
  # make_skill <root> <name> [with_evals:yes|no]
  local root="$1" name="$2" with_evals="${3:-yes}"
  local dir="${root}/${name}"
  mkdir -p "${dir}"
  cat >"${dir}/SKILL.md" <<SKILL
---
name: ${name}
description: 'Test skill ${name} for ai-skill-eval fixtures.'
---

# Test Skill ${name}

Trigger when the scenario names \`${name}\`.
SKILL

  if [[ "${with_evals}" == "yes" ]]; then
    mkdir -p "${dir}/evals"
    cat >"${dir}/evals/evals.json" <<JSON
{
  "skill_name": "${name}",
  "evals": [
    {
      "id": "positive-1",
      "should_trigger": true,
      "prompt": "Please handle a ${name} task.",
      "expectations": [
        "The response mentions \`${name}\`."
      ]
    },
    {
      "id": "negative-1",
      "should_trigger": false,
      "prompt": "A request unrelated to the skill.",
      "expectations": [
        "The response does not apply the skill."
      ]
    }
  ]
}
JSON
  fi
}

stub_driver_script() {
  # A driver stub that reads $AI_SKILL_EVAL_PROMPT_FILE and emits a
  # canned TRIGGER/REASON/NEXT_STEP reply based on what the prompt contains.
  local path="${BATS_TEST_TMPDIR}/stub-driver.sh"
  cat >"${path}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
prompt="$(cat "${AI_SKILL_EVAL_PROMPT_FILE}")"
if [[ "${prompt}" == *"handle a"* ]]; then
  cat <<REPLY
TRIGGER: yes
REASON: The scenario asks to handle the skill task.
NEXT_STEP: Apply the skill, mentioning \`sample\` in the reply.
REPLY
else
  cat <<REPLY
TRIGGER: no
REASON: The scenario is unrelated to the skill.
NEXT_STEP: Do not apply the skill; answer the user's actual question.
REPLY
fi
EOF
  chmod +x "${path}"
  printf '%s\n' "${path}"
}

# ──────────────────────────────────────────────────────────────────
# Help / version / unknown args
# ──────────────────────────────────────────────────────────────────

@test "ai-skill-eval: -h and --help print usage" {
  for flag in -h --help; do
    run bash "${SCRIPT}" "${flag}"
    assert_success
    assert_output --partial "Usage: ai-skill-eval"
    assert_output --partial "Subcommands:"
  done
}

@test "ai-skill-eval: no args prints help and exits 0" {
  run bash "${SCRIPT}"
  assert_success
  assert_output --partial "Usage: ai-skill-eval"
}

@test "ai-skill-eval: --version prints version" {
  run bash "${SCRIPT}" --version
  assert_success
  assert_output --regexp "^ai-skill-eval [0-9]+\.[0-9]+\.[0-9]+$"
}

@test "ai-skill-eval: unknown subcommand exits 2" {
  run bash "${SCRIPT}" bogus-subcommand
  assert_failure
  [ "$status" -eq 2 ]
  assert_output --partial "unknown subcommand"
}

@test "ai-skill-eval: unknown flag exits 2" {
  run bash "${SCRIPT}" list --not-a-flag
  assert_failure
  [ "$status" -eq 2 ]
  assert_output --partial "unknown option"
}

# ──────────────────────────────────────────────────────────────────
# Discovery / list
# ──────────────────────────────────────────────────────────────────

@test "ai-skill-eval list: empty project reports no skills" {
  run bash "${SCRIPT}" list
  assert_success
  assert_output --partial "No SKILL.md files discovered"
}

@test "ai-skill-eval list: discovers a skill in .agents/skills by default" {
  make_skill ".agents/skills" "sample" yes
  run bash "${SCRIPT}" list
  assert_success
  assert_output --partial "sample"
  assert_output --partial ".agents/skills/sample/SKILL.md"
  # Eval count column shows "2".
  assert_output --regexp "sample[[:space:]]+2"
}

@test "ai-skill-eval list: --skill-root overrides default scan roots" {
  make_skill "custom-root" "alpha" no
  run bash "${SCRIPT}" list --skill-root custom-root
  assert_success
  assert_output --partial "alpha"
  assert_output --regexp "alpha[[:space:]]+0"
}

@test "ai-skill-eval list: --json emits parseable JSON" {
  make_skill ".agents/skills" "alpha" yes
  make_skill ".agents/skills" "beta" no
  run bash "${SCRIPT}" list --json
  assert_success
  echo "${output}" | python3 -c 'import json,sys; data=json.load(sys.stdin); assert {d["name"] for d in data} == {"alpha","beta"}'
}

# ──────────────────────────────────────────────────────────────────
# Run via --driver-cmd stub
# ──────────────────────────────────────────────────────────────────

@test "ai-skill-eval run: writes results + grades via --driver-cmd stub" {
  make_skill ".agents/skills" "sample" yes
  driver="$(stub_driver_script)"
  run bash "${SCRIPT}" run --driver-cmd "${driver}" --workspace .ai-skill-eval
  assert_success
  assert_output --partial "# ai-skill-eval report"
  assert_output --partial "Correct TRIGGER detection: **2/2**"

  # Workspace layout.
  [ -f ".ai-skill-eval/sample/prompts/positive-1.txt" ]
  [ -f ".ai-skill-eval/sample/results/positive-1.txt" ]
  [ -f ".ai-skill-eval/sample/grades/positive-1.json" ]

  # Grades are well-formed JSON with trigger_pass true for both evals.
  python3 - <<'PY'
import json
for eid in ("positive-1", "negative-1"):
    g = json.load(open(f".ai-skill-eval/sample/grades/{eid}.json"))
    assert g["trigger_pass"] is True, g
PY
}

@test "ai-skill-eval run: --driver codex invokes codex exec with -o output capture" {
  make_skill ".agents/skills" "sample" yes

  # Stub `codex` on PATH: records its argv, writes a canned reply to -o.
  local bin="${BATS_TEST_TMPDIR}/bin"
  mkdir -p "${bin}"
  local argv_log="${BATS_TEST_TMPDIR}/codex-argv.log"
  # Build the stub with a quoted heredoc (literal "EOF") so the child
  # script sees real $@ / $# rather than the parent's expansion; inject
  # the two paths via sed.
  cat >"${bin}/codex" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ARGV_LOG="__ARGV_LOG__"
printf '%s\n' "$@" >> "${ARGV_LOG}"
printf -- '---END---\n' >> "${ARGV_LOG}"
# Snapshot the prompt (last argv) before the -o extraction shifts it away.
prompt="${@: -1}"
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    *)  shift ;;
  esac
done
if [[ "${prompt}" == *"handle a"* ]]; then
  reply=$'TRIGGER: yes\nREASON: codex stub saw trigger prompt\nNEXT_STEP: Apply the skill and mention `sample`.'
else
  reply=$'TRIGGER: no\nREASON: codex stub saw off-topic prompt\nNEXT_STEP: Do not apply the skill.'
fi
if [[ -n "${out}" ]]; then
  printf '%s' "${reply}" > "${out}"
else
  printf '%s' "${reply}"
fi
EOF
  sed -i "s|__ARGV_LOG__|${argv_log}|" "${bin}/codex"
  chmod +x "${bin}/codex"

  PATH="${bin}:${PATH}" run bash "${SCRIPT}" run --driver codex --workspace .ai-skill-eval
  assert_success
  assert_output --partial "Correct TRIGGER detection: **2/2**"

  # codex was invoked with the expected arg shape.
  grep -q '^exec$' "${argv_log}"
  grep -q '^--skip-git-repo-check$' "${argv_log}"
  grep -q '^-o$' "${argv_log}"
  grep -q '^--cd$' "${argv_log}"
  # Sandbox flag is intentionally NOT passed.
  [ "$(grep -c '^-s$' "${argv_log}" || true)" -eq 0 ]

  # Reply was captured via -o, not stdout redirection.
  grep -q 'TRIGGER: yes' .ai-skill-eval/sample/results/positive-1.txt
}

@test "ai-skill-eval run: positional arg filters to one skill" {
  make_skill ".agents/skills" "keep-me" yes
  make_skill ".agents/skills" "skip-me" yes
  driver="$(stub_driver_script)"
  run bash "${SCRIPT}" run keep-me --driver-cmd "${driver}"
  assert_success
  [ -f ".ai-skill-eval/keep-me/grades/positive-1.json" ]
  [ ! -e ".ai-skill-eval/skip-me/grades/positive-1.json" ]
}

@test "ai-skill-eval run: --only filter scopes to one eval id" {
  make_skill ".agents/skills" "sample" yes
  driver="$(stub_driver_script)"
  run bash "${SCRIPT}" run --driver-cmd "${driver}" --only positive-1
  assert_success
  [ -f ".ai-skill-eval/sample/grades/positive-1.json" ]
  [ ! -e ".ai-skill-eval/sample/grades/negative-1.json" ]
}

# ──────────────────────────────────────────────────────────────────
# Grade without re-running
# ──────────────────────────────────────────────────────────────────

@test "ai-skill-eval grade: re-grades existing results without invoking driver" {
  make_skill ".agents/skills" "sample" yes
  driver="$(stub_driver_script)"
  run bash "${SCRIPT}" run --driver-cmd "${driver}"
  assert_success

  # Driver stub that would fail if invoked; grade should not call it.
  fail_driver="${BATS_TEST_TMPDIR}/fail-driver.sh"
  cat >"${fail_driver}" <<'EOF'
#!/usr/bin/env bash
echo "driver should not be invoked during grade" >&2
exit 1
EOF
  chmod +x "${fail_driver}"

  run bash "${SCRIPT}" grade --driver-cmd "${fail_driver}"
  assert_success
  assert_output --partial "Correct TRIGGER detection: **2/2**"
}

# ──────────────────────────────────────────────────────────────────
# Report on existing workspace
# ──────────────────────────────────────────────────────────────────

@test "ai-skill-eval report: renders markdown from existing grades" {
  make_skill ".agents/skills" "sample" yes
  driver="$(stub_driver_script)"
  bash "${SCRIPT}" run --driver-cmd "${driver}" >/dev/null

  run bash "${SCRIPT}" report
  assert_success
  assert_output --partial "# ai-skill-eval report"
  assert_output --partial "sample | positive-1"
  assert_output --partial "sample | negative-1"
}

@test "ai-skill-eval report: --json emits summary + evals" {
  make_skill ".agents/skills" "sample" yes
  driver="$(stub_driver_script)"
  bash "${SCRIPT}" run --driver-cmd "${driver}" >/dev/null

  run bash "${SCRIPT}" report --json
  assert_success
  echo "${output}" | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["summary"]["total_evals"] == 2
assert d["summary"]["trigger_correct"] == 2
assert {e["eval_id"] for e in d["evals"]} == {"positive-1", "negative-1"}
'
}

# ──────────────────────────────────────────────────────────────────
# Rerun
# ──────────────────────────────────────────────────────────────────

@test "ai-skill-eval rerun: targets a single skill:eval id" {
  make_skill ".agents/skills" "sample" yes
  driver="$(stub_driver_script)"
  run bash "${SCRIPT}" rerun sample:positive-1 --driver-cmd "${driver}"
  assert_success
  [ -f ".ai-skill-eval/sample/grades/positive-1.json" ]
  [ ! -e ".ai-skill-eval/sample/grades/negative-1.json" ]
}

@test "ai-skill-eval rerun: invalid format exits 2" {
  make_skill ".agents/skills" "sample" yes
  run bash "${SCRIPT}" rerun sample-without-colon
  assert_failure
  [ "$status" -eq 2 ]
  assert_output --partial "expected SKILL:EVAL_ID"
}

@test "ai-skill-eval rerun: unknown skill exits 1" {
  make_skill ".agents/skills" "sample" yes
  run bash "${SCRIPT}" rerun nonexistent:positive-1
  assert_failure
  assert_output --partial "not found"
}

# ──────────────────────────────────────────────────────────────────
# Critic-cmd integration
# ──────────────────────────────────────────────────────────────────

@test "ai-skill-eval run: --critic-cmd JSON verdict overrides deterministic grade" {
  make_skill ".agents/skills" "sample" yes
  driver="$(stub_driver_script)"

  # Critic that always returns "all expectations pass" via JSON.
  critic="${BATS_TEST_TMPDIR}/critic.sh"
  cat >"${critic}" <<'EOF'
#!/usr/bin/env bash
cat <<'JSON'
{
  "expectations": [
    { "text": "expectation 1", "passed": true, "evidence": "critic says yes" }
  ],
  "flaws": ["critic-noted flaw"]
}
JSON
EOF
  chmod +x "${critic}"

  run bash "${SCRIPT}" run --driver-cmd "${driver}" --critic-cmd "${critic}"
  assert_success

  # Grade file should reflect the critic verdict.
  python3 - <<'PY'
import json
g = json.load(open(".ai-skill-eval/sample/grades/positive-1.json"))
assert g["grader"] == "critic", g["grader"]
assert g["expectations"][0]["passed"] is True
assert "critic-noted flaw" in g.get("flaws", [])
PY
}
