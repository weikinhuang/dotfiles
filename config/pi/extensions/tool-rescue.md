# `tool-rescue.ts`

Recovers a tool call a weak / local model emitted as literal text instead of as a real function call. On `message_end`,
parses the leaked call, strips the literal text from the message, and appends a real tool-call block so the agent loop
executes the tool normally.

## Why

A small model reliably _decides_ to call a tool, but after a few turns of prose momentum it sometimes emits the call as
literal text:

```text
generate_image(prompt="masterpiece, ...", negative="worst quality, ...")
<schedule action="create" after="1h" prompt="..." />
```

so the harness never runs it AND the raw call text breaks frame. This is an output-format degradation, not a prompt gap
(more system-prompt text was measured to do nothing about it), so the fix is at the harness layer.

## Composition

Sibling recovery extensions [`tool-arg-recovery.ts`](./tool-arg-recovery.md) and
[`edit-recovery.ts`](./edit-recovery.md) only _append nudge text_ - they never execute anything. `tool-rescue` is the
one recovery extension that **auto-executes** a tool the model named in prose, which is why the allowlist + denylist
below are load-bearing.

## Detection

Logic in [`lib/node/pi/tool-rescue.ts`](../../../lib/node/pi/tool-rescue.ts):

- Locates the earliest leaked call in the assistant text, both paren-style (`tool(arg="...")`) and XML/tag-style
  (`<tool arg="..." />`). The scan is quote- and paren-aware, so commas or parens inside a string argument don't end it
  early; an unbalanced call / unterminated tag is rejected.
- Derives the parse spec from each tool's **live parameter schema** (`pi.getAllTools()`): string props -> string args,
  number/integer props -> numeric args, `required` is the schema's required list intersected with the string props.
- A tool is rescued only when it is (1) on the allowlist, (2) currently active, (3) not on the HARD-DENY list, and (4)
  not already fired as a real tool call in the same message. A bare mention (`use generate_image()`) carries no required
  arg and is skipped.

## Safety: allowlist + hard denylist

Two boundaries gate auto-execution:

1. **Opt-in allowlist** (`tools` in `tool-rescue.json`). Default empty, so the extension is inert until you list the
   tools you want recovered. Pick non-mutating tools (e.g. `generate_image`).
2. **Built-in HARD-DENY** (non-overridable): `bash`, `bg_bash`, `edit`, `write`, `apply_patch`. These are subtracted
   from the allowlist at runtime, so a prose-leaked destructive call is **never** auto-run even if the allowlist
   mistakenly lists it. A denylisted entry is dropped with a one-time `console.warn`.

## Config shape

`tool-rescue.json`, resolved project `.pi/tool-rescue.json` unioned with user `<agentDir>/tool-rescue.json`.

```jsonc
{
  // tools eligible for rescue; HARD-DENY tools are ignored even if listed
  "tools": ["generate_image"],
}
```

See [`../tool-rescue-example.json`](../tool-rescue-example.json).

## Environment variables

- `PI_TOOL_RESCUE_ENABLED=1` - opt in (the extension is **off by default**).

Rescue therefore requires three gates in order: the opt-in env, then a non-empty `tools` allowlist, then the always-on
HARD-DENY subtraction (`bash` / `edit` / `write` / `apply_patch` / `bg_bash` are never auto-run even if listed).

This is deliberately asymmetric with the sibling `strip-reasoning` extension, which stays active-by-default behind a
`PI_STRIP_REASONING_DISABLED` kill-switch: `strip-reasoning` is a read-side, config-gated, non-destructive overlay, so
it is safe on by default. `tool-rescue` **auto-executes** a tool the model only named in prose, so it must be an
explicit opt-in - config presence alone cannot tell an RP launch from a dev session sharing the same project `.pi/`.

## Hot reload

Edit [`extensions/tool-rescue.ts`](./tool-rescue.ts) or
[`lib/node/pi/tool-rescue.ts`](../../../lib/node/pi/tool-rescue.ts) and run `/reload`. The config file is read per
message, so edits to `tool-rescue.json` take effect on the next message without a reload.
