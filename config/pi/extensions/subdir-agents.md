# `subdir-agents.ts`

Lazy loader for `AGENTS.md` / `CLAUDE.md` files nested **below** `ctx.cwd`. Replicates the discovery behaviour of Claude
Code, Codex, and opencode on top of pi.

## Why

Pi's built-in context-file loader walks **upward** from cwd at startup: `~/.pi/agent/AGENTS.md` + every `AGENTS.md` /
`CLAUDE.md` along the path from the filesystem root down to cwd. Anything **below** cwd - e.g. `tests/AGENTS.md`,
`packages/frontend/AGENTS.md`, `docs/AGENTS.md` - is never picked up automatically, even when the model is actively
editing files in that subdirectory. Other agents discover those files on file access; pi doesn't.

This extension fills in the downward direction. It watches `read` / `write` / `edit` tool calls, walks from each target
file's directory up to `ctx.cwd`, and - for every directory that has an `AGENTS.md` or `CLAUDE.md` not already loaded -
injects the file contents as a steered user message. The model sees the injected context after the current assistant
turn's tool calls complete and before its next response, which is exactly when it's about to reason about the file it
just touched.

## Scope

- **Tools watched:** `read`, `write`, `edit`. `bash` paths are too noisy to parse reliably; `grep` / `find` / `ls` don't
  imply the model is about to DO anything with the listed files.
- **Directory scope:** only files inside `ctx.cwd`. Files outside the workspace are pi's existing upward-walk problem,
  not this extension's.
- **Filenames:** `AGENTS.md`, `CLAUDE.md`. Override with `PI_SUBDIR_AGENTS_NAMES`.
- **Dedup:** both the startup-loaded baseline (captured on first `before_agent_start`) and anything this extension has
  already injected are tracked so the same file is never surfaced twice. Symlinked aliases (e.g.
  `CLAUDE.md -> AGENTS.md`) are deduped via `realpath`.
- **Size cap:** each file is capped at 16 KB of UTF-8 before injection, cut on a code-point boundary. The truncation
  notice tells the model to re-`read` the full file if it needs more.

## Delivery

The injection is a `custom`-role message with `customType: "subdir-agents"`, delivered via
`pi.sendMessage({ deliverAs: "steer" })`. In pi's internal conversion, `custom` messages become synthetic `user`
messages when serialized for the LLM, so the model genuinely sees the AGENTS.md content alongside whatever tool results
came back in that turn.

Content format:

```text
**Subdirectory context file(s) discovered:** `tests/AGENTS.md`

You just accessed files under a subdirectory with its own `AGENTS.md` / `CLAUDE.md`. These
instructions apply to work in that subtree and supplement - not replace - the project-root
context already loaded at startup.

<context file="tests/AGENTS.md">
... file contents ...
</context>
```

Multiple newly discovered files are batched into a single injection, shallowest-first, so the model reads parent
guidance before any child overrides.

## TUI rendering

The raw `content` field that the LLM consumes includes the full AGENTS.md text, which would be noisy and redundant to
print verbatim in the TUI - the user just asked to read a file in that subtree, they don't need the AGENTS.md body
echoed back at them. A `registerMessageRenderer("subdir-agents", …)` renderer collapses each injection to a compact
status line driven by `details.files`:

```text
[subdir-agents] loaded tests/AGENTS.md (3.9 KB)
[subdir-agents] loaded 2 context files (5.1 KB total)
```

When the message is expanded (`e` on the focused message in pi's TUI) and contains more than one file, the renderer also
lists the individual paths + sizes. The full file body stays in the serialized session and in the LLM's message stream -
only the user-facing rendering is trimmed.

## Commands

- `/subdir-agents` - list the startup-loaded baseline and every file this extension has injected this session.

## Environment variables

- `PI_SUBDIR_AGENTS_DISABLED=1` - skip the extension entirely.
- `PI_SUBDIR_AGENTS_NAMES=a,b,c` - comma-separated filenames to discover in each ancestor directory (default
  `AGENTS.md,CLAUDE.md`).

## Hot reload

Edit [`extensions/subdir-agents.ts`](./subdir-agents.ts) or
[`lib/node/pi/subdir-agents.ts`](../../../lib/node/pi/subdir-agents.ts) and run `/reload` in an interactive pi session.
