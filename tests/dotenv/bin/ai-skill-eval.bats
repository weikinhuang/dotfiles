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
  run bash "${SCRIPT}" run --driver-cmd "${driver}" --workspace .ai-skill-eval --runs-per-query 1
  assert_success
  assert_output --partial "# ai-skill-eval report"
  assert_output --partial "Correct TRIGGER detection: **2/2**"

  # Workspace layout nests under the config subtree (R2).
  [ -f ".ai-skill-eval/sample/with_skill/prompts/positive-1.txt" ]
  [ -f ".ai-skill-eval/sample/with_skill/results/positive-1/run-1.txt" ]
  [ -f ".ai-skill-eval/sample/with_skill/grades/positive-1.json" ]
  # No baseline dir until --baseline is passed.
  [ ! -e ".ai-skill-eval/sample/without_skill" ]

  # Grades are well-formed JSON with trigger_pass true for both evals.
  python3 - <<'PY'
import json
for eid in ("positive-1", "negative-1"):
    g = json.load(open(f".ai-skill-eval/sample/with_skill/grades/{eid}.json"))
    assert g["trigger_pass"] is True, g
    assert g["runs"] == 1, g
    assert g["config"] == "with_skill", g
PY
}

@test "ai-skill-eval run: --runs-per-query aggregates 2 yes + 1 no into trigger_rate=0.67 pass" {
  make_skill ".agents/skills" "sample" yes

  # Stub driver that returns different outputs per run by counting invocations.
  local counter_file="${BATS_TEST_TMPDIR}/run-counter"
  echo 0 >"${counter_file}"
  local driver="${BATS_TEST_TMPDIR}/stub-multirun.sh"
  # Quoted heredoc so the child sees literal $n / $counter_file; inject the
  # counter path via sed to sidestep parent-shell expansion ordering.
  cat >"${driver}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
counter_file="__COUNTER_FILE__"
n=$(cat "${counter_file}")
n=$((n + 1))
printf '%s\n' "${n}" >"${counter_file}"
if [[ ${n} -le 2 ]]; then
  cat <<REPLY
TRIGGER: yes
REASON: run ${n} sees the trigger prompt
NEXT_STEP: Apply the skill, mention \`sample\`, run \`shellcheck\` via \`./dev/lint.sh\`.
REPLY
else
  cat <<REPLY
TRIGGER: no
REASON: run ${n} disagrees
NEXT_STEP: Do not apply the skill.
REPLY
fi
EOF
  sed -i "s|__COUNTER_FILE__|${counter_file}|" "${driver}"
  chmod +x "${driver}"

  run bash "${SCRIPT}" run --driver-cmd "${driver}" --only positive-1 \
    --runs-per-query 3 --trigger-threshold 0.5
  assert_success

  # All three run files landed under <config>/results/<eval-id>/run-N.txt.
  [ -f ".ai-skill-eval/sample/with_skill/results/positive-1/run-1.txt" ]
  [ -f ".ai-skill-eval/sample/with_skill/results/positive-1/run-2.txt" ]
  [ -f ".ai-skill-eval/sample/with_skill/results/positive-1/run-3.txt" ]

  # Grade aggregates to triggers=2, runs=3, trigger_rate=0.67, trigger_pass=true.
  python3 - <<'PY'
import json
g = json.load(open(".ai-skill-eval/sample/with_skill/grades/positive-1.json"))
assert g["runs"] == 3, g
assert g["triggers"] == 2, g
assert g["trigger_rate"] == 0.67, g
assert g["trigger_pass"] is True, g
assert len(g["per_run"]) == 3, g
assert g["per_run"][0]["trigger"].lower().startswith("yes"), g
assert g["per_run"][1]["trigger"].lower().startswith("yes"), g
assert g["per_run"][2]["trigger"].lower().startswith("no"), g
PY

  # Report table carries the trigger-rate column with the N/M value.
  run bash "${SCRIPT}" report
  assert_success
  assert_output --partial "Trigger rate"
  assert_output --partial "| sample | positive-1 | yes | 2/3 |"
}

@test "ai-skill-eval run: --trigger-threshold tighter than trigger_rate flips trigger_pass to false" {
  make_skill ".agents/skills" "sample" yes
  local counter_file="${BATS_TEST_TMPDIR}/run-counter"
  echo 0 >"${counter_file}"
  local driver="${BATS_TEST_TMPDIR}/stub-multirun.sh"
  cat >"${driver}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
counter_file="__COUNTER_FILE__"
n=$(cat "${counter_file}")
n=$((n + 1))
printf '%s\n' "${n}" >"${counter_file}"
if [[ ${n} -le 2 ]]; then
  printf 'TRIGGER: yes\nREASON: r\nNEXT_STEP: s\n'
else
  printf 'TRIGGER: no\nREASON: r\nNEXT_STEP: s\n'
fi
EOF
  sed -i "s|__COUNTER_FILE__|${counter_file}|" "${driver}"
  chmod +x "${driver}"

  # trigger_rate will be 2/3 = 0.67; threshold 0.8 > 0.67 -> fail.
  run bash "${SCRIPT}" run --driver-cmd "${driver}" --only positive-1 \
    --runs-per-query 3 --trigger-threshold 0.8
  # Report exit code 1 when any trigger_pass is false.
  assert_failure
  python3 - <<'PY'
import json
g = json.load(open(".ai-skill-eval/sample/with_skill/grades/positive-1.json"))
assert g["trigger_rate"] == 0.67, g
assert g["trigger_pass"] is False, g
PY
}

@test "ai-skill-eval run: deletes the legacy flat results/<eval-id>.txt on first R2 run" {
  make_skill ".agents/skills" "sample" yes
  # Seed a pre-R1a flat result file AND a pre-R2 flat per-run dir to prove
  # both legacy shapes are purged before the R2 config-subtree layout lands.
  mkdir -p ".ai-skill-eval/sample/results/positive-1"
  printf 'stale pre-R1a\n' >".ai-skill-eval/sample/results/positive-1.txt"
  printf 'stale pre-R2\n' >".ai-skill-eval/sample/results/positive-1/run-1.txt"

  driver="$(stub_driver_script)"
  run bash "${SCRIPT}" run --driver-cmd "${driver}" --only positive-1 --runs-per-query 1
  assert_success

  # Legacy flat file + legacy flat dir are gone; new config-subtree layout is in place.
  [ ! -e ".ai-skill-eval/sample/results/positive-1.txt" ]
  [ ! -e ".ai-skill-eval/sample/results/positive-1" ]
  [ -f ".ai-skill-eval/sample/with_skill/results/positive-1/run-1.txt" ]
}

@test "ai-skill-eval: rejects --trigger-threshold outside 0.0–1.0" {
  make_skill ".agents/skills" "sample" yes
  run bash "${SCRIPT}" run --trigger-threshold 1.5
  assert_failure
  [ "$status" -eq 2 ]
  assert_output --partial "--trigger-threshold"
}

@test "ai-skill-eval: rejects --runs-per-query values less than 1" {
  make_skill ".agents/skills" "sample" yes
  run bash "${SCRIPT}" run --runs-per-query 0
  assert_failure
  [ "$status" -eq 2 ]
  assert_output --partial "--runs-per-query"
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

  PATH="${bin}:${PATH}" run bash "${SCRIPT}" run --driver codex --workspace .ai-skill-eval --runs-per-query 1
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
  grep -q 'TRIGGER: yes' .ai-skill-eval/sample/with_skill/results/positive-1/run-1.txt
}

@test "ai-skill-eval run: positional arg filters to one skill" {
  make_skill ".agents/skills" "keep-me" yes
  make_skill ".agents/skills" "skip-me" yes
  driver="$(stub_driver_script)"
  run bash "${SCRIPT}" run keep-me --driver-cmd "${driver}"
  assert_success
  [ -f ".ai-skill-eval/keep-me/with_skill/grades/positive-1.json" ]
  [ ! -e ".ai-skill-eval/skip-me/with_skill/grades/positive-1.json" ]
}

@test "ai-skill-eval run: --only filter scopes to one eval id" {
  make_skill ".agents/skills" "sample" yes
  driver="$(stub_driver_script)"
  run bash "${SCRIPT}" run --driver-cmd "${driver}" --only positive-1
  assert_success
  [ -f ".ai-skill-eval/sample/with_skill/grades/positive-1.json" ]
  [ ! -e ".ai-skill-eval/sample/with_skill/grades/negative-1.json" ]
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
  [ -f ".ai-skill-eval/sample/with_skill/grades/positive-1.json" ]
  [ ! -e ".ai-skill-eval/sample/with_skill/grades/negative-1.json" ]
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
g = json.load(open(".ai-skill-eval/sample/with_skill/grades/positive-1.json"))
assert g["grader"] == "critic", g["grader"]
assert g["expectations"][0]["passed"] is True
assert "critic-noted flaw" in g.get("flaws", [])
PY
}

# ──────────────────────────────────────────────────────────────────
# R1b: --timeout + --num-workers
# ──────────────────────────────────────────────────────────────────

@test "ai-skill-eval run: --timeout 1 kills a sleep-5 driver stub and records DRIVER_TIMEOUT in the grade" {
  make_skill ".agents/skills" "sample" yes

  # Driver stub that would block for 5s if left alone. --timeout 1 must
  # SIGTERM it, the SIGKILL fallback must land within the grace window,
  # and the run output + grade must reflect the timeout.
  local driver="${BATS_TEST_TMPDIR}/slow-driver.sh"
  cat >"${driver}" <<'EOF'
#!/usr/bin/env bash
sleep 5
printf 'TRIGGER: yes\nREASON: eventually\nNEXT_STEP: should not reach here.\n'
EOF
  chmod +x "${driver}"

  # Capture wall-clock seconds via Bash's SECONDS. Sequential 5s would be
  # far too slow; the timeout must kick in well under that.
  SECONDS=0
  run bash "${SCRIPT}" run --driver-cmd "${driver}" --only positive-1 \
    --runs-per-query 1 --timeout 1
  local elapsed=${SECONDS}
  # Grading a timed-out run yields trigger_pass=false (report exits 1),
  # so we assert on the grade contents instead of assert_success.
  [ "${elapsed}" -lt 4 ] || fail "expected timeout to fire within 4s, took ${elapsed}s"

  python3 - <<'PY'
import json
g = json.load(open(".ai-skill-eval/sample/with_skill/grades/positive-1.json"))
flaws = g.get("flaws", [])
assert any("DRIVER_TIMEOUT" in f for f in flaws), f"expected DRIVER_TIMEOUT in flaws, got {flaws!r}"
assert g["runs"] == 1, g
PY

  # A .error marker is written alongside the run output so `grade` can still
  # distinguish timeouts from ordinary non-zero exits.
  grep -q 'DRIVER_TIMEOUT' ".ai-skill-eval/sample/with_skill/results/positive-1/run-1.txt"
  [ -f ".ai-skill-eval/sample/with_skill/results/positive-1/run-1.txt.error" ]
  grep -q 'DRIVER_TIMEOUT' ".ai-skill-eval/sample/with_skill/results/positive-1/run-1.txt.error"
}

@test "ai-skill-eval run: --num-workers 2 parallelises 4 sleep-1 driver calls under sequential wall time" {
  # Four evals across two skills so even with --runs-per-query 1 the pool has
  # four independent jobs to dispatch. Sleep 1s per call → sequential ≥ 4s,
  # parallel-2 should land under 3s on any reasonable host.
  make_skill ".agents/skills" "parallel-a" yes
  make_skill ".agents/skills" "parallel-b" yes

  local driver="${BATS_TEST_TMPDIR}/sleep1-driver.sh"
  cat >"${driver}" <<'EOF'
#!/usr/bin/env bash
sleep 1
cat <<REPLY
TRIGGER: yes
REASON: stub always triggers
NEXT_STEP: Apply the skill.
REPLY
EOF
  chmod +x "${driver}"

  SECONDS=0
  bash "${SCRIPT}" run --driver-cmd "${driver}" --only positive-1 \
    --runs-per-query 1 --num-workers 2 --timeout 10 >/dev/null
  local elapsed=${SECONDS}

  [ "${elapsed}" -lt 3 ] || fail "expected --num-workers 2 on 4× sleep-1 jobs to finish under 3s, took ${elapsed}s"

  # All four per-skill, per-eval run files exist.
  [ -f ".ai-skill-eval/parallel-a/with_skill/results/positive-1/run-1.txt" ]
  [ -f ".ai-skill-eval/parallel-b/with_skill/results/positive-1/run-1.txt" ]
}

@test "ai-skill-eval: rejects --num-workers values less than 1" {
  make_skill ".agents/skills" "sample" yes
  run bash "${SCRIPT}" run --num-workers 0
  assert_failure
  [ "$status" -eq 2 ]
  assert_output --partial "--num-workers"
}

@test "ai-skill-eval: rejects negative --timeout" {
  make_skill ".agents/skills" "sample" yes
  run bash "${SCRIPT}" run --timeout -1
  assert_failure
  [ "$status" -eq 2 ]
  assert_output --partial "--timeout"
}

# ───────────────────────────────────────────────────────────────
# R2: --baseline (without-skill) runs
# ───────────────────────────────────────────────────────────────

@test "ai-skill-eval run: --baseline produces with_skill + without_skill grades and a side-by-side report with a Δ column" {
  make_skill ".agents/skills" "sample" yes

  # Stub driver that says YES when the prompt includes the SKILL block
  # and NO when it doesn't — so baseline runs diverge from the with_skill
  # runs and the report gains a non-trivial delta.
  local driver="${BATS_TEST_TMPDIR}/stub-baseline.sh"
  cat >"${driver}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
prompt="$(cat "${AI_SKILL_EVAL_PROMPT_FILE}")"
if [[ "${prompt}" == *"===== SKILL ====="* ]]; then
  cat <<REPLY
TRIGGER: yes
REASON: saw the SKILL block
NEXT_STEP: Apply the skill, mention \`sample\`, run \`shellcheck\` via \`./dev/lint.sh\`.
REPLY
else
  cat <<REPLY
TRIGGER: no
REASON: no SKILL block, falling back to general reasoning
NEXT_STEP: Handle the scenario without any specialized convention.
REPLY
fi
EOF
  chmod +x "${driver}"

  run bash "${SCRIPT}" run --driver-cmd "${driver}" --only positive-1 \
    --baseline --runs-per-query 1
  # Baseline with_skill=yes and without_skill=no is exactly what we expect on
  # a should_trigger=true eval: with_skill passes, without_skill fails. The
  # report still exit-codes on with_skill only, so the run itself is success.
  assert_success

  # Both config subtrees exist with their own prompts/results/grades.
  [ -f ".ai-skill-eval/sample/with_skill/prompts/positive-1.txt" ]
  [ -f ".ai-skill-eval/sample/with_skill/results/positive-1/run-1.txt" ]
  [ -f ".ai-skill-eval/sample/with_skill/grades/positive-1.json" ]
  [ -f ".ai-skill-eval/sample/without_skill/prompts/positive-1.txt" ]
  [ -f ".ai-skill-eval/sample/without_skill/results/positive-1/run-1.txt" ]
  [ -f ".ai-skill-eval/sample/without_skill/grades/positive-1.json" ]

  # The without_skill prompt must NOT contain the SKILL marker block.
  run grep -c '===== SKILL =====' ".ai-skill-eval/sample/without_skill/prompts/positive-1.txt"
  assert_output "0"
  grep -q '===== SKILL =====' ".ai-skill-eval/sample/with_skill/prompts/positive-1.txt"

  # Grades carry the config field so the report can split them.
  python3 - <<'PY'
import json
w = json.load(open(".ai-skill-eval/sample/with_skill/grades/positive-1.json"))
b = json.load(open(".ai-skill-eval/sample/without_skill/grades/positive-1.json"))
assert w["config"] == "with_skill", w
assert b["config"] == "without_skill", b
assert w["trigger_pass"] is True, w
assert b["trigger_pass"] is False, b
assert w["trigger_rate"] == 1.0, w
assert b["trigger_rate"] == 0.0, b
PY

  # Report carries both config blocks, the side-by-side table with a Δ
  # column, and the should_trigger=false caveat in the footer.
  run bash "${SCRIPT}" report
  assert_output --partial "## with_skill"
  assert_output --partial "## without_skill (baseline)"
  assert_output --partial "Δ trigger rate"
  assert_output --partial "| sample | positive-1 | yes |"
  assert_output --partial "+100%"
  assert_output --partial "NOT evidence that the skill helped"
}

# ─────────────────────────────────────────────────────────────
# R3.1: validate subcommand + run pre-flight
# ─────────────────────────────────────────────────────────────

make_skill_bad_frontmatter() {
  # Like make_skill but overrides the SKILL.md to trip a validate rule.
  # Args: <root> <skill-dir-name> <frontmatter-name-value>
  local root="$1" name="$2" bad_name="$3"
  make_skill "${root}" "${name}" yes
  cat >"${root}/${name}/SKILL.md" <<SKILL
---
name: ${bad_name}
description: 'Bad skill ${name}.'
---

# Bad skill
SKILL
}

@test "ai-skill-eval validate: valid skill exits 0" {
  make_skill ".agents/skills" "sample" yes
  run bash "${SCRIPT}" validate
  assert_success
  assert_output --partial "1 skill(s) validated"
}

@test "ai-skill-eval validate: positional arg scopes to one skill" {
  make_skill ".agents/skills" "alpha" yes
  make_skill ".agents/skills" "beta" yes
  run bash "${SCRIPT}" validate alpha
  assert_success
  assert_output --partial "1 skill(s) validated"
}

@test "ai-skill-eval validate: bad kebab-case name fails with a one-line diagnostic on stderr" {
  make_skill_bad_frontmatter ".agents/skills" "sample" "Not_Kebab"
  run bash "${SCRIPT}" validate
  assert_failure
  [ "$status" -eq 1 ]
  # Diagnostic includes path:line, the rule id, and the offending value.
  assert_output --partial "SKILL.md:2"
  assert_output --partial "[name-kebab-case]"
  assert_output --partial "Not_Kebab"
}

@test "ai-skill-eval validate: unknown frontmatter key fails with unknown-key rule" {
  make_skill ".agents/skills" "sample" yes
  cat >".agents/skills/sample/SKILL.md" <<'SKILL'
---
name: sample
description: 'A tiny skill.'
bogus: value
---

# body
SKILL
  run bash "${SCRIPT}" validate
  assert_failure
  assert_output --partial "[unknown-key]"
  assert_output --partial "bogus"
}

@test "ai-skill-eval run: pre-flight skips a skill with a bad SKILL.md but still runs the valid one" {
  make_skill ".agents/skills" "good-skill" yes
  make_skill_bad_frontmatter ".agents/skills" "bad-skill" "Bad_Name"
  driver="$(stub_driver_script)"

  run bash "${SCRIPT}" run --driver-cmd "${driver}" --runs-per-query 1
  # Pre-flight failure is surfaced via exit 1 even though the good skill ran.
  assert_failure
  [ "$status" -eq 1 ]
  assert_output --partial "[name-kebab-case]"
  assert_output --partial "skipping 'bad-skill'"

  # The valid skill still produced grades; the bad one didn't.
  [ -f ".ai-skill-eval/good-skill/with_skill/grades/positive-1.json" ]
  [ ! -e ".ai-skill-eval/bad-skill/with_skill/grades/positive-1.json" ]
}

# ─────────────────────────────────────────────────────────────
# R3.2: benchmark subcommand
# ─────────────────────────────────────────────────────────────

@test "ai-skill-eval benchmark: writes benchmark.json + benchmark.md under workspace (with_skill only)" {
  make_skill ".agents/skills" "sample" yes
  driver="$(stub_driver_script)"
  bash "${SCRIPT}" run --driver-cmd "${driver}" --runs-per-query 2 >/dev/null

  # Per-run metrics sidecars should exist alongside each run file.
  [ -f ".ai-skill-eval/sample/with_skill/results/positive-1/run-1.txt.meta.json" ]
  [ -f ".ai-skill-eval/sample/with_skill/results/positive-1/run-2.txt.meta.json" ]

  run bash "${SCRIPT}" benchmark
  assert_success
  assert_output --partial "benchmark.{json,md}"

  [ -f ".ai-skill-eval/sample/benchmark.json" ]
  [ -f ".ai-skill-eval/sample/benchmark.md" ]

  # JSON shape matches skill-creator's schema: metadata.skill_name, runs[],
  # run_summary.with_skill with mean/stddev/min/max.
  python3 - <<'PY'
import json
doc = json.load(open(".ai-skill-eval/sample/benchmark.json"))
assert doc["metadata"]["skill_name"] == "sample", doc["metadata"]
assert doc["metadata"]["configurations"] == ["with_skill"], doc["metadata"]
assert len(doc["runs"]) == 2, doc["runs"]
assert all(r["configuration"] == "with_skill" for r in doc["runs"])
summary = doc["run_summary"]["with_skill"]
for k in ("pass_rate", "time_seconds"):
    assert set(summary[k].keys()) == {"mean", "stddev", "min", "max"}, summary[k]
# Without --baseline there's no delta block.
assert "delta" not in doc["run_summary"]
PY

  # Markdown carries the benchmark header + a pass_rate row.
  run cat ".ai-skill-eval/sample/benchmark.md"
  assert_output --partial "# Benchmark — sample"
  assert_output --partial "| pass_rate |"
  assert_output --partial "| time_seconds |"
}

@test "ai-skill-eval benchmark: --baseline produces delta block with signed deltas" {
  make_skill ".agents/skills" "sample" yes

  # Stub driver that says YES when the prompt has the SKILL block, else NO,
  # so expectations pass with_skill and fail without_skill.
  local driver="${BATS_TEST_TMPDIR}/baseline-driver.sh"
  cat >"${driver}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
prompt="$(cat "${AI_SKILL_EVAL_PROMPT_FILE}")"
if [[ "${prompt}" == *"===== SKILL ====="* ]]; then
  printf 'TRIGGER: yes\nREASON: saw SKILL\nNEXT_STEP: Apply the skill, mention `sample`, run `shellcheck` via `./dev/lint.sh`.\n'
else
  printf 'TRIGGER: no\nREASON: no SKILL\nNEXT_STEP: plain reply.\n'
fi
EOF
  chmod +x "${driver}"

  bash "${SCRIPT}" run --driver-cmd "${driver}" --only positive-1 \
    --baseline --runs-per-query 1 >/dev/null

  run bash "${SCRIPT}" benchmark
  assert_success
  [ -f ".ai-skill-eval/sample/benchmark.json" ]

  python3 - <<'PY'
import json
doc = json.load(open(".ai-skill-eval/sample/benchmark.json"))
assert doc["metadata"]["configurations"] == ["with_skill", "without_skill"], doc["metadata"]
delta = doc["run_summary"]["delta"]
# with_skill expectation_pass > without_skill expectation_pass.
assert delta["pass_rate"].startswith("+"), delta
PY

  # Markdown gains a Δ column.
  run cat ".ai-skill-eval/sample/benchmark.md"
  assert_output --partial "Δ"
  assert_output --partial "| without_skill |"
}

@test "ai-skill-eval benchmark: empty workspace aborts with exit 1" {
  run bash "${SCRIPT}" benchmark
  assert_failure
  # The workspace dir is auto-created by main(), so we fail on "no skill
  # workspaces found" rather than "does not exist". Either message signals
  # the user needs to run `ai-skill-eval run` first.
  assert_output --partial "no skill workspaces found"
}

@test "ai-skill-eval benchmark: positional arg scopes to one skill" {
  make_skill ".agents/skills" "alpha" yes
  make_skill ".agents/skills" "beta" yes
  driver="$(stub_driver_script)"
  bash "${SCRIPT}" run --driver-cmd "${driver}" --runs-per-query 1 >/dev/null

  run bash "${SCRIPT}" benchmark alpha
  assert_success
  [ -f ".ai-skill-eval/alpha/benchmark.json" ]
  [ ! -e ".ai-skill-eval/beta/benchmark.json" ]
}
