---
name: markdown
description:
  'WHAT: Author and edit markdown in this dotfiles repo so it conforms to the project markdownlint config
  (`.markdownlint.jsonc` + the `@public-projects/agents-tooling` custom rules) and oxfmt prose-wrap settings, and runs
  through `markdownlint-cli2 --fix` and `oxfmt` cleanly. WHEN: User asks to write, edit, restructure, or fix lint on any
  `.md` / `.mdc` file under this repo (AGENTS.md, README.md, REFERENCE.md, docs/**, plans/**, .agents/skills/**, or the
  pi/agent skills under config/). DO-NOT: Hand-format markdown with custom column widths or list styles, run prettier
  instead of oxfmt, mass-rewrap a file mid-edit, or add a `README.md` inside a skill folder. Defer to the more specific
  `commit-message`, `doc-sync`, or skill/plan/AGENTS authoring guides when those apply -- this skill only governs the
  shared markdown-formatting surface.'
---

# Markdown authoring and linting

Single source of truth for "is this markdown going to land cleanly" in this repo. Wraps the project markdownlint rules,
the custom `authoring-guide` and `skill-authoring-guide` rules from `@public-projects/agents-tooling`, and oxfmt's
markdown prose-wrap behavior into one workflow.

The deep authoring conventions live in
[node_modules/@public-projects/agents-tooling/guides/skill-authoring-guide.md](../../../node_modules/@public-projects/agents-tooling/guides/skill-authoring-guide.md)
and
[node_modules/@public-projects/agents-tooling/guides/authoring-guide.md](../../../node_modules/@public-projects/agents-tooling/guides/authoring-guide.md);
read them before writing a new SKILL.md, AGENTS.md, reference doc, or plan. This skill covers the formatting and linting
surface only.

## When to use this skill

Apply whenever the user asks to:

- Add or edit any `.md` / `.mdc` file in this repo (root docs, `docs/**`, `plans/**`, `.agents/skills/**`,
  `config/**/skills/**`, package READMEs, etc.).
- Fix `markdownlint-cli2` or `oxfmt` failures on a markdown file.
- Restructure or rewrap an existing markdown file.
- Convert ad-hoc markdown into something safe to commit through `lint-staged`.

Stop and defer when the task is governed by a more specific skill:

- Commit messages and PR descriptions -- use `commit-message`.
- `REFERENCE.md` / `README.md` doc-sync after a shell-surface change -- use `doc-sync`.
- A new SKILL.md, AGENTS.md, or active plan -- still use this skill for formatting, but the structural rules live in the
  upstream authoring guides linked above.

## Repo configuration at a glance

Three config files drive the rules; do not duplicate or override them in prose, just satisfy them.

| File                           | What it sets                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `.markdownlint.jsonc`          | `default: true` (all standard rules), MD013 line length 120 (code/tables exempt), MD024 siblings-only |
| `.markdownlint-cli2.jsonc`     | Loads custom `authoring-guide` + `skill-authoring-guide` rule packs, honors `.gitignore`              |
| `oxfmt.config.ts`              | `proseWrap: 'always'`, `printWidth: 120`, `singleQuote: true`, `trailingComma: 'all'`                 |
| `lint-staged.config.mjs`       | On commit: `markdownlint-cli2 --fix --no-globs` then `oxfmt` for `*.{md,mdc}`                         |
| `research/.markdownlint.jsonc` | Research subtree relaxes MD013 to 1200 and disables MD034 -- only applies under `research/`           |

`plans/**` is in the markdownlint `ignores` list, so plan files do not get linted on commit. Still wrap at 120 and use
the same conventions; the lint exemption is for in-flight drafting, not a license to ship malformed prose.

## Rules to satisfy

Standard markdownlint defaults all apply. The ones that bite most often in this repo:

- **MD003 / MD022 / MD023** -- ATX-style headings (`#`, not Setext underlines), surrounded by blank lines, no leading
  whitespace.
- **MD013 line length 120**, code blocks and tables exempt. Wrap prose at 120; do not split inside an inline code span
  if it would push the line under but break the span.
- **MD024 siblings_only** -- duplicate headings are fine across H2 sections, not within the same parent.
- **MD025** -- exactly one H1 per file. The H1 must come before the first H2.
- **MD031 / MD032** -- fenced code blocks and lists must be surrounded by blank lines.
- **MD034 no-bare-urls** -- wrap URLs in `<https://...>` or `[text](url)`. (Disabled under `research/` only.)
- **MD036** -- do not use bold/italic as a fake heading; use a real heading.
- **MD040** -- code fences need a language tag (`text` is fine for plain output, `bash` for shell, `sh` when the command
  is portable, `ts` for TypeScript, `jsonc` for commented JSON).
- **MD047** -- single trailing newline at end of file.
- **MD051** -- relative anchor links must point at real headings; rename safely.

Custom rules from `@public-projects/agents-tooling` (see
[skill-authoring-guide.md](../../../node_modules/@public-projects/agents-tooling/guides/skill-authoring-guide.md) for
the full surface):

- `skill-authoring-guide-frontmatter-required` / `frontmatter-shape` -- every `.agents/skills/*/SKILL.md` and
  `config/**/skills/*/SKILL.md` needs YAML frontmatter with `name` (kebab-case, matching the directory) and a
  `description` containing all three of `WHAT:`, `WHEN:`, `DO-NOT:` markers, under 1024 characters, no angle brackets.
- `skill-authoring-guide-folder-layout` -- skill subdirectories must be from the allowed set (`scripts`, `references`,
  `assets`, `evals`).
- `skill-authoring-guide-no-readme` -- never put a `README.md` inside a skill folder; use `SKILL.md`.
- `skill-authoring-guide-resource-mentions` -- if a skill has a non-empty `scripts/`, `references/`, or `assets/`
  directory, `SKILL.md` must mention it.
- `skill-authoring-guide-skill-required-sections` -- SKILL.md needs both a "when to use" section (e.g.
  `## When to use this skill`) and an action-oriented section (`## Steps`, `## Workflow`, `## Procedure`,
  `## Diagnostic flow`, etc.).
- `authoring-guide-doc-size-budget` -- soft caps: root AGENTS.md 120 lines, nested AGENTS.md 80, reference docs in
  `docs/` 300, active plans 400, skills 500. Trim or split when you exceed.
- `authoring-guide-non-empty-required-sections` -- AGENTS.md `Commands` / `Directory map` / `Key patterns` /
  `Boundaries` / `References` sections must have content; reference docs in `docs/**` must include `Related docs`.
- `authoring-guide-doc-opening-structure` -- docs start with an H1 and an early scope-statement paragraph.
- `authoring-guide-related-docs-last` / `-required` -- in reference docs, `## Related docs` is required and must be the
  final H2.
- `authoring-guide-no-bare-repo-paths` / `path-references` / `local-links` -- repo paths in prose must be markdown links
  or `path:` references, links must be relative, and `path:` references must point at real files.
- `authoring-guide-directory-map-table` / `-paths` -- AGENTS.md `## Directory map` is a `Path | Purpose` table whose
  paths resolve.
- `authoring-guide-boundaries-shape` -- AGENTS.md `## Boundaries` uses `Always`, `Ask first`, `Never` markers.
- `authoring-guide-commands-shape` -- AGENTS.md `## Commands` uses a bash fence or described command bullets.

## Style conventions to layer on top of lint

Lint passes are necessary but not sufficient. Match the existing tone:

- **Imperative, concrete, low-fluff prose.** No marketing voice, no rhetorical asides; see the `commit-message` skill
  for the rule set, applied here too.
- **No em-dashes (`—`) anywhere.** Use a regular hyphen with spaces around it (`-`) or restructure the sentence.
  Existing skills are written this way; oxfmt does not auto-convert.
- **Tables for tabular data, lists for steps, fenced code for commands.** Do not encode steps as a numbered table; do
  not encode a table as a bulleted list.
- **Single quotes in YAML frontmatter** when the description contains colons (which it always does, due to `WHAT:` /
  `WHEN:` / `DO-NOT:`). Escape inner single quotes by doubling them (`it''s`). Existing skills use this; do not switch
  to double quotes mid-file.
- **Relative links** to real files (`../../../node_modules/.../guide.md`, `../bats-test-conventions/SKILL.md`). No
  absolute paths, no bare URLs to repo files.
- **Code fence languages**: `bash` for shell snippets the user runs, `sh` only when truly POSIX, `text` for opaque
  output, `ts` / `tsx` / `jsonc` / `yaml` / `toml` as appropriate. Never leave a fence untagged.
- **One blank line between block elements.** Two blanks is not "more readable", it is a lint failure waiting to happen.

## oxfmt and prose wrap

`oxfmt` runs after `markdownlint-cli2 --fix` on commit, so it reflows prose last:

- `proseWrap: 'always'` rewraps each paragraph to fit `printWidth: 120`. Do not hand-wrap to a narrower width to "look
  nicer"; oxfmt will undo it and the diff churns.
- Lists, fenced code, and tables are not reflowed. Keep table rows as one logical line.
- Hard line breaks (two trailing spaces or `\`) are preserved; use them only when meaningful.
- Inline HTML, comments (`<!-- -->`), and link reference definitions are left alone.

If oxfmt reflows your wrapping on the first run after editing, that is expected; let it win and move on.

## Workflow

1. **Read before writing.** For an edit, `read` the file (and any neighbors) so you match local voice and section
   structure. For a new SKILL.md / AGENTS.md / plan / docs reference, read the relevant authoring guide in
   `node_modules/@public-projects/agents-tooling/guides/` first.
2. **Pick the right home.** SKILL.md goes in `.agents/skills/<kebab-name>/`; pi/agent skills go in
   `config/agents/skills/<kebab-name>/` or `config/pi/skills/<kebab-name>/`. Reference docs go in `docs/`. Active
   execution plans go in `plans/`. Domain READMEs sit at the directory root they index.
3. **Draft to the rules.** Write with the lint rules in mind: ATX headings, blank lines around blocks, fence languages,
   relative links, no bare URLs, no em-dashes, 120-column prose.
4. **Lint with autofix.** Run `npm run markdownlint -- <files>` (or `npx markdownlint-cli2 --fix '<glob>'`) on the
   touched files first; full-suite `npm run markdownlint` before claiming done if the change spans many files.
5. **Format.** Run `npx oxfmt <files>` (or `npm run format -- <files>`) to apply prose-wrap. Re-read the diff; if oxfmt
   rewrapped a paragraph, accept its choice rather than fighting it.
6. **Re-lint.** Run `npm run markdownlint:check -- <files>` (or `npx markdownlint-cli2 '<glob>'` without `--fix`) to
   confirm no remaining findings. The `:check` script omits `--fix` so it surfaces anything the autofix could not
   resolve.
7. **Verify links and paths.** For any `path:` reference, link to a docs file, or directory-map entry, run a quick `ls`
   / `read` to confirm the target exists. The `path-references`, `directory-map-paths`, and `local-links` rules will
   fail otherwise.
8. **Stage and commit.** `lint-staged` re-runs both tools on commit; if either fails, fix and re-stage rather than
   bypassing with `--no-verify`.

## Validation gates

Before claiming the markdown change is done, all of these must pass:

- `npx markdownlint-cli2 '<changed-files-glob>'` exits 0 (no `--fix`, so it reflects what the autofix could not
  resolve).
- `npx oxfmt --check <files>` exits 0.
- For SKILL.md: directory name matches frontmatter `name`, frontmatter contains `WHAT:` / `WHEN:` / `DO-NOT:`, and the
  body has at least one `## When to use this skill` and one action-oriented section (`## Workflow`, `## Steps`,
  `## Procedure`, `## Diagnostic flow`).
- For AGENTS.md: line count under the budget (root 120, nested 80), and the required sections are non-empty.
- For reference docs in `docs/**`: ends with `## Related docs` containing real links.

Quote the relevant pass output in the reply, per `lint-and-test-gate`.

## Common pitfalls

- **Bypassing oxfmt** by hand-wrapping at 80 or 100 characters. The reflow runs on commit; the diff fights you next
  edit. Wrap at 120.
- **Setext-underline H1/H2** (`====` / `----` under a heading). MD003 wants ATX (`#` / `##`).
- **Code fences without a language tag.** MD040 fails. Use `text` if nothing else fits.
- **Bare URLs** like `https://example.com` in prose. Use `<https://example.com>` or `[anchor](https://example.com)`.
- **Bare repo paths in prose** like `dotenv/bin/git-sync`. Wrap them in a markdown link to the file or use
  `path: dotenv/bin/git-sync`. Code spans (`` `dotenv/bin/git-sync` ``) are also accepted by `no-bare-repo-paths` for
  reference; check the rule output if unsure.
- **Em-dashes in prose, especially around the `WHAT/WHEN/DO-NOT` markers.** The existing skills standardize on hyphens
  with spaces.
- **README.md inside a skill folder.** `skill-authoring-guide-no-readme` blocks it. Put installation notes in a
  repo-level README.
- **New skill subdirectories** beyond `scripts/` / `references/` / `assets/` / `evals/`. The folder-layout rule rejects
  anything else.
- **Frontmatter description missing one of the three markers** (`WHAT:`, `WHEN:`, `DO-NOT:`). All three are required;
  the rule is checked verbatim, so do not paraphrase the markers.
- **Frontmatter `name` not matching the directory name.** Both must be kebab-case and identical.
- **Adding `## Related docs` to a SKILL.md just because reference docs need one.** It is required only in `docs/**.md`,
  not in skills.
- **Editing `REFERENCE.md` / README.md without running the `doc-sync` workflow** -- markdown lint will pass, but the doc
  surface will be inconsistent.
- **Letting lint-staged silently fix a file you did not re-read.** Always re-read after `--fix` so you understand the
  diff that landed.

## Quick reference

| Need                           | Command                                       |
| ------------------------------ | --------------------------------------------- |
| Lint everything (with autofix) | `npm run markdownlint`                        |
| Lint everything (check only)   | `npm run markdownlint:check`                  |
| Lint a single file (autofix)   | `npx markdownlint-cli2 --fix path/to/file.md` |
| Format prose (oxfmt)           | `npm run format -- path/to/file.md`           |
| Check format only              | `npm run format:check -- path/to/file.md`     |
| Confirm a path link resolves   | `ls path/to/target` or `read` it              |

## Related docs

- [Skill authoring guide](../../../node_modules/@public-projects/agents-tooling/guides/skill-authoring-guide.md) -
  Source of truth for SKILL.md frontmatter, layout, and validation rules.
- [Documentation authoring guide](../../../node_modules/@public-projects/agents-tooling/guides/authoring-guide.md) -
  AGENTS.md, reference doc, and plan structure rules enforced by the custom markdownlint pack.
- [commit-message skill](../commit-message/SKILL.md) - Subject + body rules that also apply to markdown prose voice.
- [doc-sync skill](../doc-sync/SKILL.md) - Pair this skill with `doc-sync` whenever a code change touches the public
  shell surface.
- [lint-and-test-gate skill](../lint-and-test-gate/SKILL.md) - Repo-wide rule: quote the pass output before claiming
  done.
