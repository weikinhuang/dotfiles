# `protected-paths.ts`

Session-scoped approval gate for pi's built-in `read`, `write`, and `edit` tools. Complements
[`extensions/bash-permissions.ts`](./bash-permissions.md) (which owns the `bash` channel).

## What's protected

The gate has two rule categories with separate threat models:

- **`read` rules** gate the `read` tool. Aimed at files whose **contents** are sensitive (secrets, private keys).
  Reading is a plausible exfiltration path for an LLM, but reading files OUTSIDE the workspace is often legitimate
  (READMEs of nearby repos, config templates, etc.), so outside-workspace is **not** enforced for reads.
- **`write` rules** gate `write` / `edit`. Aimed at files/dirs that are dangerous to **mutate** even if reading is fine.
  The effective write rule set is `read ∪ write` - anything sensitive-to-read is trivially sensitive-to-write, so
  there's no need to duplicate entries. Outside-workspace IS enforced for writes.

Defaults:

| Category                        | `read`                     | `write` (in addition to `read`) |
| ------------------------------- | -------------------------- | ------------------------------- |
| `basenames` (glob on basename)  | `.env`, `.env.*`, `.envrc` | -                               |
| `segments` (any path segment)   | -                          | `node_modules`, `.git`          |
| `paths` (tilde-expanded prefix) | `~/.ssh`                   | -                               |
| Outside workspace               | (not enforced)             | always on                       |

`paths` is checked before outside-workspace so a write to `~/.ssh/config` reports the specific reason instead of the
generic "outside workspace." A leading `~` in the tool's `path` argument is expanded to the current user's home
directory before classification (`~/.env` → `$HOME/.env`), so tilde paths can't sneak past the basename or path-prefix
checks. `~user/` syntax isn't supported - it's almost never emitted by an LLM and would need a password-db lookup.

Symlink-following is intentionally **not** attempted: the classifier uses `path.resolve()` (lexical), so a symlink that
escapes a protected path is treated as its link path. Fix with file-watcher-grade logic if you need it.

`grep`, `find`, and `ls` are currently **not** gated. Their output is bounded by pi's built-in size limits and they
rarely exfiltrate raw secrets on their own - add them to this extension if that assumption changes for your threat
model.

## Approval flow

Session-scoped only - there's no persistent allowlist, because these paths are almost always incidental and you rarely
want pi touching them silently forever.

1. Allow once
2. Allow `<path>` for this session
3. Deny
4. Deny with feedback…

The session allowlist is **shared** across tools: approving a path for the session satisfies subsequent reads AND writes
of the same file. If you vetted a path for one, you vetted it for the other.

In non-interactive mode (`-p`, JSON, RPC without UI) the gate blocks by default; set `PI_PROTECTED_PATHS_DEFAULT=allow`
to override.

## Custom rules

Rules are additive across four layers (any match prompts - there's deliberately no "deny" escape hatch, since the point
of the gate is to make accidental access **loud**):

1. Built-in defaults (the table above)
2. User: `~/.pi/protected-paths.json`
3. Project: `.pi/protected-paths.json` inside `ctx.cwd`
4. Env var: `PI_PROTECTED_PATHS_EXTRA_GLOBS` (extra basename globs, merged into BOTH `read` and `write`)

Config files are JSONC - `//` line comments and C-style block comments are allowed. Shape:

```jsonc
{
  // Gated for the `read` tool. Put contents-sensitive files here.
  "read": {
    "basenames": ["*.key", "id_*"], // glob (`*`, `?`) on the file's basename
    "segments": [], // exact match on any path segment
    "paths": ["~/secrets"], // tilde-expanded path prefix
  },
  // Gated for `write` / `edit` IN ADDITION TO the `read` rules above.
  // Put mutation-dangerous dirs here (no need to repeat `read` entries).
  "write": {
    "basenames": [],
    "segments": [".terraform", ".vault"],
    "paths": [],
  },
}
```

Rule files are re-read on every tool call, so edits take effect immediately. Missing files are silent; malformed JSONC
logs a single `[protected-paths]` warning per unique error.

## Composition with the persona extension

When the [`persona.ts`](./persona.ts) extension has an active persona, this extension treats the persona's resolved
`writeRoots` as a **positive vouch**: any `write` / `edit` whose absolute path is inside one of those roots skips the
protected-paths gate entirely. The author of a persona file is opting into that directory by declaring it in
`writeRoots`, so re-prompting via protected-paths would be redundant and (in non-UI mode) deadlocking - the same write
would get blocked twice with no way for the model to recover.

Reads are **not** affected: `read` rules still apply even inside an active persona's `writeRoots`. Reading a `.env` is
still suspicious regardless of who's authoring the persona.

The vouch flows through the singleton at
[`../../../lib/node/pi/persona/active.ts`](../../../lib/node/pi/persona/active.ts), which the persona extension
publishes on activation / clear / `session_shutdown`. If `persona.ts` isn't loaded, the singleton stays empty and this
extension behaves exactly as it did before.

## Commands

- `/protected-paths` - list the active protection rules grouped by source and the current session allowlist.

## Environment variables

- `PI_PROTECTED_PATHS_DISABLED=1` - bypass the gate entirely.
- `PI_PROTECTED_PATHS_DEFAULT=allow` - in non-UI mode, allow unknown paths instead of blocking.
- `PI_PROTECTED_PATHS_EXTRA_GLOBS=a,b,c` - extra basename globs merged into BOTH `read` and `write` (supports `*` and
  `?`). Equivalent to adding them to the `basenames` array under both categories in `~/.pi/protected-paths.json`.
