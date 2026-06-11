---
name: skill-author
description: >
  WHAT: Author a new skill folder (SKILL.md plus optional references/scripts/assets) when a recurring pattern in your
  work should carry into future sessions; pick project-local or global scope. WHEN: you hit the same friction twice in a
  session and corrected it the same way both times; the user tells you to remember a procedure ("from now on do X",
  "always do Y before Z", "please remember", "don't do that again"); or you fixed a mistake you would predictably
  repeat. Reach for this even if the user doesn't say "make a skill". DO-NOT: create a skill on a single observation;
  duplicate an existing skill (~70% description overlap means edit it instead); restate a convention already in
  AGENTS.md or CLAUDE.md; edit or delete skills you did not author this turn.
---

# Skill author

Governs how you author new agent skills on your own initiative. A skill is a folder under `.agents/skills/<slug>/`
containing a `SKILL.md` (frontmatter + body) that conforms to the open [Agent Skills spec](https://agentskills.io/home)
and is portable across Claude Code, Codex, pi, opencode, and the other ~30 adopting harnesses.

Follow the seven sections below in order. Do not skip the dedup check, do not skip the subagent eval, do not edit older
skills you did not just author.

## When to author a skill

All three preconditions must hold. If any fails, do not author -- save a memory if your harness has one, or let it pass.

1. **Recurrence.** You observed the same friction (same correction, same forgotten step, same retry pattern) at least
   twice in the current session, OR the user explicitly told you to remember a procedure.
2. **Generality.** The pattern would apply in a future session you have not seen yet. One-off bug fixes do not become
   skills; the _method_ that fixed a class of bugs might.
3. **Not already covered.** No existing skill's description covers the same ground. Run the pre-write dedup check below.

## Pre-write dedup check

1. List both skills directories: `ls <project>/.agents/skills/ ~/.agents/skills/` (where `<project>` is
   `git rev-parse --show-toplevel`, falling back to the cwd if not in a git repo).
2. Read each existing `SKILL.md`'s YAML frontmatter (name + description only -- not the body).
3. For each, ask: _does my proposed description overlap by ~70 percent or more with this one?_
   - **Yes:** stop. Edit that skill instead. Add a `DO-NOT` clause or an extra `WHEN` case, plus a short body addition.
   - **No to all:** proceed.

This is human-judgement dedup, not lexical scoring. The 70 percent figure is a sanity anchor.

## Skills directory and scope

Always write to `.agents/skills/`. Two paths, no harness detection:

| Scope  | Path                        |
| ------ | --------------------------- |
| Local  | `<project>/.agents/skills/` |
| Global | `~/.agents/skills/`         |

Pick local or global by answering, in order. First match wins.

1. **Is the skill content specific to this repo's code, build system, conventions, or tooling?** -> local.
2. **Does the skill name a specific file path, directory, command, or env var defined in this repo?** -> local.
3. **Does the skill encode a user preference about how _they_ like to work (terseness, language, tooling habits) that
   would carry across every project?** -> global.
4. **Does the skill describe a general engineering practice the user just taught you (testing discipline, commit
   hygiene, debugging method) that is not tied to this repo's specifics?** -> global.
5. **Default if uncertain:** local. A skill that turns out to apply everywhere can be moved later; a globally written
   skill that leaks repo-specific assumptions is harder to spot.

If the chosen `.agents/skills/` directory does not exist, create it. The first authored skill bootstraps it.

## Naming and folder layout

- Slug: `kebab-case`, ideally two or three words, verb- or noun-first. Examples: `commit-message`, `lint-and-test-gate`,
  `bin-script-scaffold`.
- The slug must equal the parent directory name and the `name:` frontmatter field exactly.
- Layout (per the [agentskills.io spec](https://agentskills.io/home)):

  ```text
  <skills-dir>/<slug>/
  ├── SKILL.md          # Required
  ├── references/       # Optional - long-form docs the body links to
  ├── scripts/          # Optional - executable helpers the body invokes
  └── assets/           # Optional - templates / static files
  ```

- Default: write only `SKILL.md`. Add a subdirectory _only_ when the body would exceed ~500 lines (push overflow into
  `references/<topic>.md` and link it from the body) or when the skill genuinely needs a reusable script or template. Do
  not create empty subdirectories.
- If the slug collides within the chosen scope, the dedup check should have caught it. If it did not, suffix `-2`.

## Description (frontmatter)

The description is the retrieval key -- it is what the harness's skill router sees. Use **WHAT / WHEN / DO-NOT** and
write it **pushy** per the
[agentskills.io optimizing-descriptions guide](https://agentskills.io/skill-creation/optimizing-descriptions).

- `WHAT:` one sentence in imperative voice stating the skill's job. Focus on user intent, not implementation ("Author a
  new skill folder when..." rather than "This skill provides skill-authoring logic for...").
- `WHEN:` one or two sentences in imperative voice ("Use this skill when..."). Include realistic phrases users actually
  say ("from now on do X", "don't do that again"). Add an explicit "even if the user does not say [domain term]" pull
  when adjacent triggers are common.
- `DO-NOT:` one sentence listing the most common misapplications (overlap with adjacent skills, scope leakage).

Hard cap: **1024 characters**. Under-triggering is harder to notice than over-triggering, so lean pushy -- the `DO-NOT`
clause keeps "pushy" from becoming "fires on everything." If you cannot write the `WHEN` clause concretely, the skill is
not ready.

**Format:** YAML block scalar (`description: >`), one paragraph that folds into a single line on load. Never use the
quoted-string form. No XML angle brackets (`<`, `>`) inside frontmatter values -- some harnesses treat frontmatter as
privileged prompt text and mis-parse them.

```yaml
---
name: lint-and-test-gate
description: >
  WHAT: Run lint and the relevant test suite before claiming a change is done. WHEN: Use this skill whenever you are
  about to report a code change as complete, especially after editing shell, TypeScript, or markdown files, even if the
  user does not explicitly say "test it." DO-NOT: Skip lint when only docs changed; do not run the full suite for a
  one-file edit when a targeted test exists.
---
```

## Body

The body is what the agent reads when the skill fires. Sections:

- One-paragraph framing ("this skill governs X, here is the why").
- A `## When to use this skill` section reproducing the description's `WHEN:` cases in expanded form.
- A bulleted `Do` list with concrete actions, ideally with one short example each.
- A bulleted `Do not` list with the failure modes the description's `DO-NOT:` clause hinted at.
- (Optional) `## Gotchas` -- per
  [agentskills.io best-practices](https://agentskills.io/skill-creation/best-practices#gotchas-sections), often the
  highest-value section: concrete corrections to mistakes the agent will make without being told otherwise.
- (Optional) `Examples` with a good-vs-bad pair.

Avoid long prose, multi-paragraph rationale, or references to specific session turns ("when you did X earlier"). The
body must read coherently months later in a session with no memory of the moment the skill was created. Follow the
spec's "add what the agent lacks, omit what it knows" rule -- do not explain general concepts the agent already
understands.

**Length budget:** authored skills follow the
[agentskills.io spec](https://agentskills.io/specification#progressive-disclosure) ceiling of **≤500 lines and ≤5000
tokens** for `SKILL.md`. Skills that need more push overflow into `references/<topic>.md`. The body must tell the agent
_when_ to load each reference ("Read `references/api-errors.md` if the API returns a non-200 status") -- generic "see
references/ for details" is the failure mode the spec calls out.

## Pre-write eval via subagent

Self-eval is biased: the agent that decided to author a skill will rate its own draft generously. Spawn an isolated
subagent to evaluate the description before writing anything to disk.

1. **Draft, do not write.** Compose the proposed `SKILL.md` (frontmatter + body) in memory.
2. **Generate 4 test queries.** 2 that _should_ trigger the skill (the situations it was authored for) and 2 that
   _should not_. The should-not queries are most useful as **near-misses** -- queries that share keywords or concepts
   with the skill but actually need something different.
3. **Spawn one evaluator subagent** with a fresh context (no parent-session memory). Use the host harness's spawn
   primitive: `Task` (Claude Code), `subagent` (pi), or the equivalent task/subagent tool (Codex, opencode, others).
   Prompt shape:

   ```text
   You are evaluating a proposed agent skill. Here is its frontmatter:

   <name + description>

   For each of the following user messages, answer LOAD (the skill's description tells you to load its body
   before replying) or SKIP (the description does not match). Output JSON:
   [{"msg": "...", "verdict": "LOAD"|"SKIP"}]. Messages: <the 4 sample turns>.
   ```

4. **Decide from the verdict matrix:**
   - **4/4 correct** (both should-trigger -> `LOAD`, both should-not -> `SKIP`): write the skill.
   - **3/4 correct:** revise the description (tighten on a false positive, broaden on a false negative) and re-run the
     eval _once_. If the second pass is not 4/4, abandon. When revising, **do not copy specific keywords from the
     failing query** -- the spec calls this overfitting. Address the general category instead.
   - **≤ 2/4 correct:** abandon. The pattern is real but not yet articulable as a skill. Save a memory if the harness
     supports one; do not write.

5. **Fallback when no subagent capability exists.** If the harness exposes no subagent / task tool, skip the eval, write
   the skill, and append `eval:skipped` to the audit log line below.

## Markdown formatting (write lint-clean, no manual reformat)

Authored skills must pass markdownlint without manual cleanup, both here and in other repos that adopt the
`@public-projects/agents-tooling` ruleset.

**Universal `SKILL.md` rules (always apply):**

1. **Frontmatter required.** Starts with `---`-fenced YAML containing at least `name` and `description`.
2. **`name` is kebab-case** matching `^[a-z0-9]+(?:-[a-z0-9]+)*$` and **must equal the parent directory name**.
3. **`description` ≤ 1024 chars** and must contain the three literal markers `WHAT:`, `WHEN:`, `DO-NOT:`.
4. **No XML angle brackets (`<`, `>`)** anywhere in frontmatter values.
5. **Folder layout limited to `SKILL.md` plus `scripts/`, `references/`, `assets/`.** No other top-level files or
   directories inside the skill folder. Empty subdirectories not created.
6. **No `README.md` inside the skill folder.** Install / distribution notes go in a repo-level README outside it.
7. **Resource-directory mentions.** If `scripts/`, `references/`, or `assets/` contains files, the body must mention the
   directory by name (e.g., write `references/api-errors.md` not just "see the references").

**Universal body-prose rules:**

1. **One H1 per file** (MD025). The H1 is the skill's display title.
2. **No duplicate sibling headings** (MD024 with `siblings_only: true`).
3. **No em-dashes (`—`)** anywhere in body prose. Use the regular hyphen `-`.

**Formatting defaults (apply unless the destination repo overrides):**

1. **Line length ≤ 120 chars** for prose; code blocks and tables exempt.
2. **Block scalar `description: >`**, never quoted strings.

**Portability check (run before writing):**

- If the destination repo has `.markdownlint.jsonc` / `.markdownlint.json` / `.markdownlint-cli2.jsonc`, read it and
  adjust formatting defaults (line length especially) to match. Universal rules 1-10 do not change.
- If the destination repo's `customRules` reference `@public-projects/agents-tooling`, all universal rules above are
  enforced there too -- write directly.
- If the destination repo has no markdownlint config, write to the defaults above; the result passes the markdownlint
  stdlib default ruleset.

## Audit trail

After writing the skill folder, append one line to `~/.agents/skill-author.log` (single canonical location, no matter
the scope) in TSV form:

```text
<ISO-8601-timestamp>\t<slug>\t<scope>\t<eval>\t<absolute-path>\t<rationale>
```

Columns: ISO-8601 timestamp; slug; scope (`local` or `global`); eval verdict (`4-of-4`, `3-of-4-revised`, or `skipped`);
absolute path to the written `SKILL.md`; one-line rationale.

The log is append-only, no rotation. `grep eval:skipped ~/.agents/skill-author.log` surfaces anything that bypassed the
evaluator subagent for spot-review.

## Do not

- Do not author on a single observation -- recurrence is required (§ "When to author a skill").
- Do not duplicate an existing skill -- edit it instead (§ "Pre-write dedup check").
- Do not edit or delete skills you did not just author in this turn. Editing the freshly written skill within the same
  turn (e.g., after eval feedback) is allowed; rewriting older skills is not.
- Do not write to `~/.codex/skills/`, `.opencode/skills/`, `~/.pi/agent/skills/`, or any other harness-specific path.
  Always `.agents/skills/`.
- Do not edit `MEMORY.md`, `AGENTS.md`, or `CLAUDE.md`. Those are the human's territory.
- Do not author a skill for content already in repo documentation (`AGENTS.md`, `CLAUDE.md`, `docs/`).
- Do not register tools or run executable code. The one exception is the pre-write eval, which spawns a single
  short-context evaluator subagent via the harness's existing primitive.

## Gotchas

- **The skill router sees the description, not the body.** A perfect body behind a vague description never fires. Spend
  most of the authoring effort on the WHAT/WHEN/DO-NOT clauses.
- **Block scalar folds newlines to spaces.** Write the description as readable multi-line YAML; it renders as one
  paragraph at load time. Do not pre-collapse into a single long line.
- **Cross-harness tool names differ.** The body must refer to actions ("read the file", "write the file"), not tool
  names. Only the pre-write eval step names harness-specific primitives, and it lists all of them.
- **Local scope defaults win ties.** When in doubt between local and global, choose local. Moving a skill up to global
  later is cheap; finding repo-specific leakage in a global skill is not.
- **The audit log is global even for local skills.** Both scopes log to `~/.agents/skill-author.log`. The absolute-path
  column makes local entries findable after `cd` away from the project.
