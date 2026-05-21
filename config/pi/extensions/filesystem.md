# `filesystem.ts`

Session-scoped approval gate for pi's built-in `read`, `write`, and `edit` tools. Reads the unified
`~/.pi/filesystem.json` policy shared with the kernel-level [`sandbox.ts`](./sandbox.md) extension so the in-process
gate and the syscall gate stay in lockstep.

Together with [`bash-permissions.ts`](./bash-permissions.md) (regex-layer bash gate) and [`sandbox.ts`](./sandbox.md)
(kernel-layer sandbox), this is one of three composable security gates - see plan section 2 for the full threat-model
table.

## What's protected

The unified policy has two top-level categories with separate semantics:

- **`read`** (deny-then-allow-back): a path matched by `read.deny.*` is gated unless it ALSO matches `read.allow.*`,
  which carves narrow "allow-back" holes inside an otherwise-denied prefix. Empty `read.deny.*` means "allow
  everything".
- **`write`** (allow-only): the path must be inside one of `write.allow.paths`, otherwise the gate fires with reason
  `outside-allowed-write`. Inside the allowed area, `write.deny.*` carves additional holes (`.git/hooks`, `.env*`, ...).
  Writes outside the allow set always prompt (in-process) AND block (kernel sandbox).

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
2. Allow `<path>` for this session
3. Deny
4. Deny with feedback…

The session allowlist is **shared** across `read` / `write` / `edit`: approving a path satisfies subsequent calls of
either kind for the same absolute path until `session_shutdown`.

In non-interactive mode (`pi -p`, JSON, RPC without UI) the gate blocks by default; set `PI_FILESYSTEM_DEFAULT=allow` to
override.

## Custom rules

Layered, additive within categories:

1. Built-in `DEFAULT_POLICY`
2. User: `~/.pi/filesystem.json`
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
    // ALLOW-ONLY: writes outside these paths are gated in-process AND
    // by the kernel sandbox.
    "allow": {
      "basenames": [],
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

[`sandbox.ts`](./sandbox.md) reads the same `~/.pi/filesystem.json` and translates it into the
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
[`registerSubagentInjection`](../../../lib/node/pi/subagent-extension-injection.ts) on load, so spawned subagent
sessions (`runOneShotAgent`, the `subagent` extension's inline `DefaultResourceLoader`) automatically apply the gate to
child `read` / `write` / `edit` calls. The factory mounts ONLY the `tool_call` handler - no slash command, no statusline
glue. Children run with `hasUI: false`, so the approval dialog never fires; unknown protected paths fall through to
`PI_FILESYSTEM_DEFAULT` (default deny). Defaults / user / project / persona overlay are re-read from disk per call
inside the child, so a matching policy entry still blocks the tool call.

## Commands

- `/filesystem` - list the active resolved policy (defaults / user / project / persona) plus the session allowlist.

## Environment variables

- `PI_FILESYSTEM_DISABLED=1` - bypass the gate entirely.
- `PI_FILESYSTEM_DEFAULT=allow` - in non-UI mode, allow unknown paths instead of blocking.
