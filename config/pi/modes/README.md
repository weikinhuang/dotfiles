# pi mode definitions

Mode definitions consumed by [`../extensions/mode.ts`](../extensions/mode.ts) (the `/mode <name>` command, `--mode`
flag, and `Ctrl+Shift+M` cycle) and discovered via the layered `modes/` registry. Each file pins a session-lifetime
persona — tools, write-path scope, bash policy, and a system-prompt body — so the parent session takes on a single role
at a time. See [`../extensions/mode.md`](../extensions/mode.md) for the schema, layering rules, and
`protected-paths`-style ask-on-violation UX.

This directory is the **shipped catalog**. Users override per-mode-name by dropping a file with the same stem under
`~/.pi/modes/` (user-global) or `<cwd>/.pi/modes/` (project-local); later layers win. The mode loader ignores
`README.md` / `readme.md`, so this index can stay frontmatter-free.

## Index

| Mode                           | `agent:` ref | writeRoots               | One-liner                                                   |
| ------------------------------ | ------------ | ------------------------ | ----------------------------------------------------------- |
| [`chat.md`](./chat.md)         | —            | (none)                   | Long-form Q&A with web access; no writes.                   |
| [`debug.md`](./debug.md)       | —            | (none)                   | Reproduce-and-instrument; cannot modify files.              |
| [`explain.md`](./explain.md)   | —            | (none)                   | Walk through code already in context, no tools beyond read. |
| [`journal.md`](./journal.md)   | —            | `journal/`               | Date-templated reflective log.                              |
| [`kb.md`](./kb.md)             | —            | `~/notes/{projectSlug}/` | Curate knowledge base + memories.                           |
| [`plan.md`](./plan.md)         | `plan`       | `plans/`                 | Drop a plan doc; never edits source.                        |
| [`research.md`](./research.md) | —            | `research/`              | Interactive research notes (sibling of `/research`).        |
| [`review.md`](./review.md)     | `explore`    | `reviews/`               | Read-only on source, drop a markdown PR review.             |
| [`roleplay.md`](./roleplay.md) | —            | `drafts/`                | Fiction / brainstorming with persistent character notes.    |
| [`shell.md`](./shell.md)       | —            | (none)                   | Ops mode: AI runs commands but never edits files.           |

## How to add a mode

- **Filename → mode name.** The file stem is the canonical name (`plan.md` → `mode:plan`). The `name:` frontmatter field
  is optional and only needed for overrides where the stem can't change.
- **Frontmatter schema.** See [`../extensions/mode.md`](../extensions/mode.md) for the full table — `description`,
  `tools`, `writeRoots`, `bashAllow`, `bashDeny`, optional `agent:` inheritance, optional `model` / `thinkingLevel` /
  `appendSystemPrompt`. Body markdown becomes the system-prompt addendum.
- **Inherit when it fits.** A mode can declare `agent: <name>` to pull body and defaults from
  [`../agents/`](../agents/README.md). Mode-only fields (`tools`, `writeRoots`, bash policy) declared on the mode
  replace the agent's values rather than merging — see [`plan.md`](./plan.md) and [`review.md`](./review.md) for
  examples.
- **Project-local overrides** go under `<cwd>/.pi/modes/<name>.md`. User-global overrides go under
  `~/.pi/modes/<name>.md`. Same stem ⇒ same mode name; later layer wins. `<cwd>/.pi/mode-settings.json` overrides
  `writeRoots` per-mode-name without rewriting the file.
- **Parse warnings** surface once each via `ctx.ui.notify(..., 'warning')`. Bad frontmatter doesn't blind the catalog —
  the offending mode is dropped, others load. Run `/mode info <name>` after editing to see the resolved record.

## Related docs

- [../extensions/mode.ts](../extensions/mode.ts) — the extension shell that loads this directory.
- [../extensions/mode.md](../extensions/mode.md) — deep doc: schema, layering, ask-on-violation UX, env vars,
  composition with `preset` / `protected-paths` / `bash-permissions`.
- [../agents/README.md](../agents/README.md) — the agent format `agent:`-ref modes inherit from.
