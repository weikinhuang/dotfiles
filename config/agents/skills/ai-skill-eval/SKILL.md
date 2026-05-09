---
name: ai-skill-eval
description:
  'WHAT: Use the `ai-skill-eval` CLI to validate that an AI model (especially a small local one) actually follows a
  SKILL.md — run per-skill evals through a driver, grade TRIGGER detection + expectation match, and read the report.
  WHEN: You have drafted or edited a SKILL.md, or a teammate wants proof a skill still works after a rewrite, or you
  want to regression-test a whole skill set against a new model. DO-NOT: Skip writing positive + negative evals; claim a
  skill is validated without quoting the report; rely on the deterministic keyword-match grade as the final judgment
  when a subjective rubric is at stake — plug in `--critic-cmd` instead.'
---

# ai-skill-eval

The `ai-skill-eval` CLI ships on `$PATH` via this dotfiles repo. It exists so that any SKILL.md edit can be empirically
re-tested against a real model — most usefully a cheap local one (default: `llama-cpp/qwen3-6-35b-a3b` via `pi -p`) so
the author gets fast signal on whether a small model can actually follow what the skill says.

## When to reach for this skill

- You drafted a new SKILL.md and want proof a small model reads it correctly.
- You edited an existing skill's WHAT / WHEN / DO-NOT and want to confirm the change didn't regress trigger detection.
- Someone asks "does this skill still work against model X?" — run the eval with `--model X`.
- You want to extend coverage by adding more scenarios to an existing skill's `evals/evals.json`.

Skip this skill when:

- You're running a one-off smoke test during drafting and don't care about a persisted grade.
- The skill under question has no verifiable behavior (pure style guide with no triggerable action).
- You don't have time for a model round-trip and a manual read of the skill is enough signal.

## Prerequisites

1. `ai-skill-eval` is on `$PATH` (installed by this dotfiles repo; verify with `command -v ai-skill-eval`).
2. A driver is available — either `pi` or `claude` on `$PATH`, or a `--driver-cmd` string you supply.
3. The skill under test has a sibling `evals/evals.json` (see schema below). If not, author it first.
4. `node` ≥ 24 is on `$PATH` — the CLI is a TypeScript executable that relies on Node's built-in type-stripping (present
   in this repo's test Docker image).

## Authoring evals (the heart of skill validation)

Each skill gets one `evals/evals.json` file sibling to its `SKILL.md`. The file has two kinds of entries per skill:

- **Positive eval**: a realistic scenario where the skill's WHEN clause _should_ fire.
- **Negative eval**: a near-miss scenario where the skill should _not_ fire (prevents over-triggering).

```json
{
  "skill_name": "plugin-conventions",
  "evals": [
    {
      "id": "positive-1",
      "should_trigger": true,
      "prompt": "I want to add a new plugin for the 'zoxide' CLI. It should set _ZO_DATA_DIR if unset and add a 'cd' wrapper. What conventions do I need to follow?",
      "expectations": [
        "The response names the 'command -v zoxide &>/dev/null || return' guard as mandatory.",
        "The response suggests a 10- or 30- numeric prefix (not a brand-new tier).",
        "The response mentions DOT_PLUGIN_DISABLE_zoxide as the disable switch."
      ]
    },
    {
      "id": "negative-1",
      "should_trigger": false,
      "prompt": "The user wants to add 'export LANG=en_US.UTF-8' to the shared dotfiles environment. No new tool.",
      "expectations": [
        "The response recognizes this is a phase-file edit, not a plugin.",
        "The response does not propose creating a new plugin file."
      ]
    }
  ]
}
```

Rules of thumb for writing evals:

- **Prompts read like real user messages.** "Please fix the bug on line 42" beats "Scenario: bug at line X".
- **Expectations name concrete artifacts.** Backtick-quote file paths, command names, and flags — the deterministic
  grader keyword-matches on those. Natural-language expectations need `--critic-cmd` to judge well.
- **Negative evals are load-bearing.** A skill that fires on everything is as broken as one that never fires. Ship a
  negative case for every positive.
- **Two evals is a smoke test; 8–10 is a benchmark.** Scale coverage to the stakes of the skill.

## Core commands

### Discover what's available

```bash
ai-skill-eval list
```

Prints the discovered skills and how many evals each has. Scan roots default to `.agents/skills`,
`config/agents/skills`, `config/pi/skills`, and `.claude/skills` (any that exist in cwd). Override with
`--skill-root DIR` (repeatable).

### Run and grade everything

```bash
ai-skill-eval run
```

For each discovered skill that has `evals/evals.json`:

1. Builds the prompt: skill body + scenario + instruction to emit `TRIGGER:` / `REASON:` / `NEXT_STEP:`.
2. Invokes the driver (default: `pi -p ... --model llama-cpp/qwen3-6-35b-a3b --no-session`).
3. Parses the reply, grades `TRIGGER` exact-match and `expectations` via keyword-match.
4. Writes a markdown report to stdout.

Expected first run: ~15–20 seconds per eval against qwen3 on the local llama-cpp server.

### Narrow the run

After a skill revision, `run <skill>` is the normal path (full skill re-validation). Reach for `rerun` only when you
want to target a single failed eval.

```bash
# After editing a skill: re-validate the whole skill (both positive + negative evals).
ai-skill-eval run plugin-conventions

# One eval across all skills (filter by eval id):
ai-skill-eval run --only positive-1

# One specific failed eval after a skill revision (the fast-iteration loop):
ai-skill-eval rerun plugin-conventions:positive-1

# Use a different model:
ai-skill-eval run --model llama-cpp/some-other-local

# Use claude instead of pi:
ai-skill-eval run --driver claude --model claude-haiku-4-5

# Use codex (OpenAI CLI):
ai-skill-eval run --driver codex --model gpt-5-codex

# Custom driver (any command that reads $AI_SKILL_EVAL_PROMPT_FILE and prints the reply):
ai-skill-eval run --driver-cmd 'ollama run llama3 < "$AI_SKILL_EVAL_PROMPT_FILE"'
```

`rerun` REQUIRES the `SKILL:EVAL_ID` form (colon + eval id) — `rerun plugin-conventions` alone is a usage error. If you
want to re-run the whole skill, use `run plugin-conventions` instead.

### Re-grade without re-running

After tweaking expectations or a critic prompt:

```bash
ai-skill-eval grade plugin-conventions
```

Uses the stored results under `.ai-skill-eval/plugin-conventions/results/*.txt`; does not call the driver.

### Subjective grading with a critic

The default grader is a lower-bound keyword-match. To get real judgment on expectation prose, plug in a critic:

```bash
ai-skill-eval run --critic-cmd 'claude -p "$(cat "$AI_SKILL_EVAL_PROMPT_FILE")" --model claude-haiku-4-5 --bare'
```

The critic is sent a prompt containing the skill, eval, model reply, and expectations, and must return JSON:

```json
{
  "expectations": [{ "text": "...", "passed": true, "evidence": "..." }],
  "flaws": ["..."]
}
```

Any critic driver is fine as long as it writes JSON on stdout. The critic's verdict overrides the keyword-match verdict
in each eval's grade file.

### Report existing results

```bash
ai-skill-eval report                  # markdown
ai-skill-eval report --json           # machine-readable
ai-skill-eval report plugin-conventions
```

## Interpreting the output

Every grade file includes:

- `trigger_pass` — hard signal. If this is ever false, the skill's WHEN clause is ambiguous. Revise before shipping.
- `expectation_pass` / `expectation_total` — soft signal under deterministic grading; hard signal under critic.
- `reason` / `next_step` — the model's actual reply, useful for reading why a grade came out the way it did.
- `grader` — `"deterministic"` or `"critic"`, so you know which verdict you're looking at.

**Success criteria for shipping a skill:**

1. `trigger_correct / total == 1.0` (every positive fires, every negative doesn't).
2. Under critic: `expectation_pass / expectation_total >= 0.85` with `flaws` addressed or documented.
3. The `NEXT_STEP` text for each positive eval names the specific commands/paths/conventions the skill taught.

If (1) fails, the skill's WHEN clause is wrong or weak — rewrite it, don't patch around it. If (2) or (3) fails, the
skill's DO list isn't emphatic enough — check if a rule is buried in prose; promote it into a dedicated section with a
canonical example.

## Iteration workflow

1. Draft or edit the skill.
2. Write/update `evals/evals.json` (positive + negative per skill, minimum).
3. `ai-skill-eval run <skill>` and read the markdown report.
4. For each failing eval:
   - Read the `NEXT_STEP` text carefully — what did the model miss?
   - If the miss is in the skill's wording, revise the skill. Common fixes:
     - Canonical commands that paraphrased away → promote to an explicit code block.
     - Rules that got dropped → split into their own named section.
     - Over-triggering → tighten the WHEN clause with an explicit exclusion.
   - If the miss is genuinely a model limitation unlikely to improve, write a more permissive expectation or document
     the limitation.
5. `ai-skill-eval rerun <skill>:<failed-eval-id>` to confirm the fix.
6. Once the affected evals pass, run the full suite once more to catch regressions.

## Workspace layout

Default: `.ai-skill-eval/` in cwd (gitignored in this repo). Per skill:

```text
.ai-skill-eval/
└── <skill-name>/
    ├── prompts/<eval-id>.txt        (what was sent to the driver)
    ├── results/<eval-id>.txt        (raw model reply)
    └── grades/<eval-id>.json        (parsed + graded)
```

`grade` / `report` / `rerun` all read from this workspace. Override with `--workspace DIR` to keep per-run workspaces
separate (handy when benchmarking several models back-to-back).

## Anti-patterns

- **Shipping a skill with only positive evals.** One positive per skill tells you it triggers; without a negative you
  don't know whether it _only_ triggers on the right scenarios.
- **Treating a 0/N deterministic expectation score as failure.** The default grader is a lower bound — 0/N on
  well-written skills is common when expectations are natural-language. Run with `--critic-cmd` before despairing.
- **Editing expectations to match the model's reply.** If the model got it wrong, the skill is probably wrong — fix the
  skill. Only edit expectations when the original wording was genuinely unverifiable.
- **Running against only one model.** Skills that pass qwen3 pass claude-haiku; the reverse isn't guaranteed. Test on
  the weakest model you support.
- **Skipping the rerun step.** After a skill revision, a targeted `rerun` is seconds; a full suite is minutes. Use the
  right tool.

## Quick reference

| Situation                                            | Command                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| See what's discoverable                              | `ai-skill-eval list`                                                                              |
| Validate all skills against the default model        | `ai-skill-eval run`                                                                               |
| Validate one skill                                   | `ai-skill-eval run <skill-name>`                                                                  |
| After revising a skill, re-validate the whole skill  | `ai-skill-eval run <skill-name>`                                                                  |
| After revising a skill, rerun just one failed eval   | `ai-skill-eval rerun <skill>:<eval-id>`                                                           |
| Re-grade existing results with stricter expectations | Edit `evals.json`, then `ai-skill-eval grade <skill>`                                             |
| Want subjective grading                              | add `--critic-cmd 'claude -p "$(cat "$AI_SKILL_EVAL_PROMPT_FILE")" --bare'`                       |
| Drive a non-pi/claude model                          | `--driver-cmd 'your-wrapper.sh'` where the wrapper reads `$AI_SKILL_EVAL_PROMPT_FILE`             |
| Machine-readable grades for CI                       | `ai-skill-eval report --json`                                                                     |
| Write the first eval                                 | See the JSON schema in the "Authoring evals" section above — one positive, one negative, minimum. |
