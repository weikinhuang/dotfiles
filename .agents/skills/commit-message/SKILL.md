---
name: commit-message
description:
  'WHAT: Draft commit messages and PR descriptions for this dotfiles repo, defaulting to subject-only and adding a short
  body only when the why is not visible in the diff. WHEN: User asks to commit, write or rewrite a commit message, or
  open or describe a pull request. DO-NOT: Add test counts, lint or typecheck sign-offs, per-file walkthroughs, or
  marketing voice; do not write a body when the subject already conveys the change.'
---

# Commit and PR messages

Governs the shape of commit messages and PR descriptions in this repo. Commits are the focus; PR descriptions follow the
same rules with a slightly looser length budget and an optional test-plan checklist.

## When to use this skill

Apply these rules whenever the user asks to:

- Draft a commit message or commit staged changes.
- Open a pull request or write a PR description.
- Rewrite or tighten an existing commit or PR message.

Read the staged diff (or the diff being committed) before drafting. Pick the subject first, then decide whether a body
is warranted using the rules below. When in doubt, skip the body.

## Subject line

Format: `<area>: <change>` or `<area>: <component> - <change>`.

- `<area>` is a top-level path segment, e.g. `config/pi`, `lib`, `dotenv`, `dotenv/bin`, `plugins`, `tests`.
- `<component>` is the file or feature being changed, used when the area alone is ambiguous. Joined to the change with
  `-` (a regular hyphen surrounded by spaces).
- Imperative mood ("add", "fix", "strip"), no trailing period.
- Aim for ~72 chars; go over only if truncating loses meaning.
- No em-dashes (`—`) anywhere. Use the regular hyphen.

Good:

- `config/pi: verify-before-claim - auto-detect pre-commit hooks`
- `lib/research: retry transient fanout network errors`
- `dotenv/bin: add genpasswd --no-symbols flag`

Avoid:

- `config/pi: verify-before-claim — auto-detect pre-commit hooks` (em-dash)
- `Update bash-match.ts` (no area, not imperative-feeling)
- `config/pi: small fix to verify-before-claim.` (vague + trailing period)

## When to write a body

**Default: no body.** Subject-only is the right answer for most commits in this repo.

Add a body only when at least one is true:

- The _why_ isn't visible in the diff (closes a specific bypass, motivated by an incident, external constraint,
  surprising default).
- A non-obvious tradeoff or scope decision was made (deliberate omission, security/perf implication).
- Behavior or contract changed in a way a future reader could trip over.

Skip the body for: refactors, renames, dependency bumps, doc edits, straightforward feature additions where the subject
says it all, follow-ups whose context is obvious from the parent commit.

## Body shape

When a body is warranted:

- **Bullets by default.** Prose only if bullets feel forced.
- **Lead with the why.** Then the what, in one or two bullets.
- **~10 lines is a soft cap.** Aim for it, but go over when the change has multiple independent moving parts or a
  non-obvious decision that needs to land. Don't pad to fill, don't cut to fit.
- **Voice: technical-writer neutral.** Document what changed and why, the way release notes or API changelog entries
  read. No personality asides ("Not great.", "Liberal on purpose."), no marketing verbs ("Ships", "Closes the loop"), no
  rhetorical flourish ("smuggle vector"). Plain declarative sentences.
- **Wrap at ~72 chars.**
- **Don't restate the subject** as the first sentence.

## Never include

- Test counts: "375/375 pass", "92 files, 2656 tests".
- Lint/typecheck sign-offs: "tsc clean", "shellcheck/shfmt clean", "eslint clean on touched files".
- Per-file change walkthroughs (`~ path  description` blocks, "Files:" sections).
- Per-test enumeration of what each spec covers.
- "Out of scope" sections - only mention an omission if a reader would reasonably expect it to be in scope.
- Regex / code-style explanations the diff already shows.
- Marketing voice ("Ships a reviewed...", "Closes the loop...").

## PR descriptions

Same subject and body rules. Two extras:

- A short test plan as a markdown checklist if the change is non-trivial. One-bullet PRs can skip it.
- Skip the `## Summary` header when the body is a single bullet or short paragraph.

## Examples

### Subject only is enough

```text
config/pi: @mariozechner/pi-coding-agent => @earendil-works/pi-coding-agent
```

```text
lib/research: findExistingRun helper for slug-collision detection
```

### Subject plus minimal why

```text
config/pi: stream-watchdog - bump default stall to 120s

The 60s default cancelled long tool_input_json_delta bursts on
Bedrock Claude; large edit payloads can take 60-90s between flushes.
```

### Tightened from a real recent commit

Original (~90 lines, full per-file walkthrough, test counts, lint sign-off, regex explanation):

```text
config/pi: bash-permissions — strip control-flow keywords + add for/select/case/bat

Closes a control-flow bypass in the decision gate and expands the
`readonly` baseline example with the missing shell-syntax coverage.

1. Control-flow keyword strip (lib/node/pi/bash-match.ts):
   * splitCompound cuts on `&&` / `||` / `;` / newlines, so a compound
     like `if [[ -f foo ]]; then rm -rf /; fi` surfaces as three subs:
     ['if [[ -f foo ]]', 'then rm -rf /', 'fi']. The hardcoded rm
     denylist regex anchors to `^\s*rm\s+...`, so `then rm -rf /` used
     to sail past it — a real smuggle vector via any if/while/until
     branch.
   ...
[80 more lines]
```

Tightened:

```text
config/pi: bash-permissions - strip control-flow keywords from compound subs

splitCompound split `if [[ -f x ]]; then rm -rf /; fi` into subs
beginning with bare `then`/`else`/etc., which bypassed the rm
denylist anchored to `^\s*rm\s+`.

- Strip leading if/elif/then/else/while/until/do/! before the
  precedence ladder. for/select/case are left intact because their
  positional arguments are not commands.
- Add for/select/case and `bat` (with cache and write-config guards)
  to the example allowlist.
```

## Workflow

1. Read the staged diff (or the diff being committed) before drafting.
2. Pick the subject: area, optional component, imperative change.
3. Decide whether a body is warranted by the rules above. When in doubt, skip it.
4. If writing a body, lead with the why, keep it to bullets, treat ~10 lines as a soft cap.
