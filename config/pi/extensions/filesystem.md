# `filesystem.ts`

Session-scoped approval gate for pi's built-in `read`, `write`, and `edit` tools. Reads the unified
`~/.pi/agent/filesystem.json` policy shared with the kernel-level [`sandbox.ts`](./sandbox.md) extension so the
in-process gate and the syscall gate stay in lockstep.

Together with [`bash-permissions.ts`](./bash-permissions.md) (regex-layer bash gate) and [`sandbox.ts`](./sandbox.md)
(kernel-layer sandbox), this is one of three composable security gates - see plan section 2 for the full threat-model
table.

## What's protected

The unified policy has two top-level categories with separate semantics:

- **`read`** (deny-then-allow-back): a path matched by `read.deny.*` is gated unless it ALSO matches `read.allow.*`,
  which carves narrow "allow-back" holes inside an otherwise-denied prefix. Empty `read.deny.*` means "allow
  everything".
- **`write`** (allow-only with carve-back): the path must be inside one of `write.allow.paths`, otherwise the gate fires
  with reason `outside-allowed-write`. Inside the allowed area, `write.deny.*` carves holes (`.git/hooks`, `.env*`,
  ...) - which `write.allow.basenames` / `write.allow.segments` can carve back open again, mirroring `read.allow` for
  the deny set. `write.allow.paths` is the OUTER GATE only and does NOT participate in carve-back, so the default `'.'`
  (cwd) doesn't accidentally cancel every `write.deny.*` rule under the workspace. Writes outside the allow set always
  prompt (in-process) AND block (kernel sandbox).

Defaults (`DEFAULT_POLICY` in
[`lib/node/pi/filesystem-policy/schema.ts`](../../../lib/node/pi/filesystem-policy/schema.ts)):

| Category               | Patterns                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `read.deny.basenames`  | `.env`, `.env.*`, `.envrc`                                                         |
| `read.deny.paths`      | `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.kube`, `~/.docker/config.json` |
| `write.allow.paths`    | `.` (the session's `ctx.cwd`), `/tmp` - persona `writeRoots` merged on top         |
| `write.deny.basenames` | `.env`, `.env.*`                                                                   |
| `write.deny.segments`  | `.git/hooks`, `.git/config`, `node_modules`                                        |

Tilde paths (`~/`, `~`) are expanded; `~user/` syntax is **not** supported. Symlink-following is intentionally not
attempted - the classifier uses `path.resolve()` (lexical), so a symlink that escapes a protected path is treated as its
link path. This is asymmetric with the kernel sandbox (which enforces by realpath via bwrap / sandbox-exec); the
[`sandbox.ts`](./sandbox.md) deep doc surfaces the divergence in `/sandbox`'s lossy-translation report.

`grep`, `find`, and `ls` are intentionally **not** gated. Their output is bounded by pi's built-in size limits, and the
kernel sandbox already covers the read channel for any of them invoked via bash.

## Approval flow

Session-scoped only - no persistent allowlist for paths, because they're almost always incidental.

1. Allow once
2. Allow `<file>` for this session
3. Allow directory `<parentDir>/` for this session
4. Allow git root `<gitRoot>/` for this session (only when the file is inside a git repo)
5. Deny
6. Deny with feedback…

Options 3-4 widen the scope of the "for this session" grant: picking the parent directory or the git root remembers that
path as a **prefix**, so any later `read` / `write` / `edit` under it is allowed without re-prompting. The git-root
option is omitted when the repo root coincides with the parent directory (or the file itself), and the whole option is
absent for paths outside any git repo. The git root is found by walking up from the file's directory for a `.git` entry
(directory or worktree file) via [`lib/node/pi/filesystem/git-root.ts`](../../../lib/node/pi/filesystem/git-root.ts).

The session allowlist is **shared** across `read` / `write` / `edit` and is **prefix-matched**: approving a path (file
or directory) satisfies subsequent calls of either kind for that path and anything beneath it until `session_shutdown`.

In non-interactive mode (`pi -p`, JSON, RPC without UI) the gate blocks by default; set `PI_FILESYSTEM_DEFAULT=allow` to
override.

## Custom rules

Layered, additive within categories:

1. Built-in `DEFAULT_POLICY`
2. User: `~/.pi/agent/filesystem.json`
3. Project: `.pi/filesystem.json` inside `ctx.cwd`
4. Persona overlay: the active persona's resolved `writeRoots` are merged into `write.allow.paths` (positive vouch)

Files are JSONC (`//` and C-style block comments allowed). See
[`config/pi/filesystem-example.json`](../filesystem-example.json) for a hand-curated example. Shape:

```jsonc
{
  "read": {
    "deny": {
      "basenames": [".env", ".env.*", ".envrc"],
      "segments": [],
      "paths": ["~/.ssh", "~/.aws"],
    },
    // Carve narrow holes inside the deny set, e.g.:
    "allow": {
      "basenames": [],
      "segments": [],
      "paths": ["~/.config/gh/hosts.yml"],
    },
  },
  "write": {
    // OUTER GATE: writes outside these `paths` are gated in-process
    // AND by the kernel sandbox. `basenames` / `segments` here act
    // as CARVE-BACK inside the deny set (NOT extra outer-gate roots).
    "allow": {
      "basenames": [],
      // Example: re-allow vitest's bundle dir back through the
      // node_modules segment-deny:
      //   "segments": ["node_modules/.vite-temp"]
      "segments": [],
      "paths": [".", "/tmp"],
    },
    "deny": {
      "basenames": [".env", ".env.*"],
      "segments": [".git/hooks", ".git/config", "node_modules"],
      "paths": [],
    },
  },
}
```

Files are re-read on every tool call, so edits take effect immediately. Missing files are silent; malformed JSONC logs a
single `filesystem: <path>: <reason>` warning per unique error.

## Composition with the persona extension

When the [`persona.ts`](./persona.md) extension has an active persona, this extension treats the persona's resolved
`writeRoots` as a **positive vouch**: any `write` / `edit` whose absolute path is inside one of those roots skips the
filesystem gate entirely. The author of a persona file is opting into that directory by declaring it in `writeRoots`, so
re-prompting via filesystem rules would be redundant and (in non-UI mode) deadlocking.

Reads are **not** affected: `read.deny.*` rules still apply even inside an active persona's `writeRoots`. Reading a
`.env` is suspicious regardless of who's authoring the persona.

The vouch flows through the singleton at
[`../../../lib/node/pi/persona/active.ts`](../../../lib/node/pi/persona/active.ts), which the persona extension
publishes on activation / clear / `session_shutdown`. The persona's `writeRoots` are also merged into
`write.allow.paths` at policy-load time so the kernel sandbox sees the same vouch.

## Composition with the sandbox extension

[`sandbox.ts`](./sandbox.md) reads the same `~/.pi/agent/filesystem.json` and translates it into the
[@anthropic-ai/sandbox-runtime](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime) `SandboxRuntimeConfig` so
that the kernel-level enforcement matches the in-process gate. A read of `~/.ssh/id_rsa` smuggled through
`bash -c 'cat ~/.ssh/id_rsa'` (which `bash-permissions` may have allowed) hits EPERM at the syscall layer; pi's own
`read` of the same path prompts via this extension.

The two layers are **complementary, not redundant**:

- The in-process gate matches lexically and runs inside pi's Node process. It sees `read` / `write` / `edit` tool calls.
  It does NOT see anything bash does (subprocess paths).
- The kernel sandbox enforces by realpath at the syscall layer. It bounds bash subprocesses. It does NOT see pi's
  in-process file tools.

Plan section 9.20 documents one platform asymmetry worth knowing about: a `write.deny.paths` entry pointing at a
not-yet-existing file is enforced on Linux/bwrap (EROFS on the write) but silently dropped on macOS/sandbox-exec. The
in-process gate here is unaffected (it matches lexically), so the two layers stay complementary.

## Subagent injection

This extension registers `filesystemFactoryHookOnly` via
[`registerSubagentInjection`](../../../lib/node/pi/subagent/extension-injection.ts) on load, so spawned subagent
sessions (`runOneShotAgent`, the `subagent` extension's inline `DefaultResourceLoader`) automatically apply the gate to
child `read` / `write` / `edit` calls. The factory mounts ONLY the `tool_call` handler - no slash command, no statusline
glue. Children run with `hasUI: false`, so the child's own approval dialog can never fire. There are two outcomes for an
unknown protected path inside a child:

- **Parent-UI approval (default in an interactive parent).** When the `subagent` extension has published the parent's UI
  (see its [`parent-prompt` bridge](./subagent.md#parent-ui-approval-bridge)) and the calling session is a registered
  subagent child, the gate routes the approval to the **parent's** dialog, labelled `subagent <agent> (<handle>)`, and
  serialized so parallel children prompt one at a time. `Allow once` / `Allow for this session` / `Deny` /
  `Deny with feedback…` behave as in the parent; `Allow for this session` is remembered for the rest of that child run.
- **Non-interactive fallback.** When no parent UI is available (headless `pi -p`, or the bridge is disabled via
  `PI_SUBAGENT_DISABLE_PARENT_PROMPT=1`), unknown protected paths fall through to `PI_FILESYSTEM_DEFAULT` (default deny)
  just like a `pi -p` run.

Defaults / user / project / persona overlay are re-read from disk per call inside the child, so a matching policy entry
still blocks (or allows-back) the tool call before either prompt path is reached.

## Commands

- `/filesystem` - list the active resolved policy (defaults / user / project / persona) plus the session allowlist.

## Hot reload

- **Policy files** (`filesystem.json` defaults / user / project / persona overlay) -- re-read on every tool call, so
  edits take effect immediately without `/reload`.
- **Session allowlist** -- in-memory, cleared on `session_shutdown`; a `/reload` resets it to empty.
- **`PI_FILESYSTEM_DEFAULT`** -- read once at registration, so changing it needs `/reload` (or a session restart).
- **The extension code itself** -- edits to [`filesystem.ts`](./filesystem.ts) or the helpers under
  [`../../../lib/node/pi/filesystem-policy/`](../../../lib/node/pi/filesystem-policy) need `/reload`.

## Environment variables

- `PI_FILESYSTEM_DISABLED=1` - bypass the gate entirely.
- `PI_FILESYSTEM_DEFAULT=allow` - in non-UI mode, allow unknown paths instead of blocking.
