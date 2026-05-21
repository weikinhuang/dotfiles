# `sandbox.ts`

Kernel-level sandbox for every `bash` subprocess pi runs. Wraps each command via
[`@anthropic-ai/sandbox-runtime`](https://www.npmjs.com/package/@anthropic-ai/sandbox-runtime) ("ASRT"), which enforces
filesystem and network restrictions at the OS level: `sandbox-exec` on macOS, `bubblewrap` on Linux. Even if the model
smuggles a `cat ~/.ssh/id_rsa` past the regex matcher in [`bash-permissions.ts`](./bash-permissions.md), the kernel
still blocks the syscall.

This is the third (lowest) layer in pi's defense-in-depth chain - it composes with, not replaces, the other two:

| Layer                                          | Channel                   | Mechanism                     | Catches                                                       | Blind spots                                                |
| ---------------------------------------------- | ------------------------- | ----------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------- |
| [`bash-permissions.ts`](./bash-permissions.md) | `bash`, `bg_bash`         | string allow/deny + UI prompt | known-shape bad commands                                      | `eval "$(echo Y2F0...)"`, base64 payloads, novel binaries  |
| [`filesystem.ts`](./filesystem.md)             | `read` / `write` / `edit` | path classifier + UI prompt   | pi's in-process file tools                                    | doesn't see anything bash does                             |
| `sandbox.ts`                                   | every bash subprocess     | OS kernel sandbox via ASRT    | filesystem / network / unix-socket calls by FILE not by REGEX | pi's own in-process tools (run inside the pi node process) |

## Default posture and graceful degradation

Default-on. Wraps every bash subprocess as soon as deps are detected. Per plan section 6:

| Situation                                                           | Behavior                                                                                 |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Platform unsupported (Windows, WSL1)                                | Identity-wrap. One-time `notify('warning', ...)`. Statusline `🛡️?`.                      |
| Platform supported, deps missing (`bubblewrap`, `socat`, `ripgrep`) | Identity-wrap with loud install hints. Statusline `🛡️?`. Re-init via `/sandbox-recheck`. |
| Platform supported, deps present                                    | Wrap normally. Statusline `🛡️`.                                                          |
| pi running as root (`process.getuid() === 0`)                       | Refuse to load. Override via `PI_SANDBOX_ALLOW_ROOT=1`.                                  |
| `PI_SANDBOX_DISABLED=1`                                             | Identity-wrap. Statusline `🛡️·off`.                                                      |
| `/sandbox-disable` (session-only)                                   | Identity-wrap. Statusline shows strikethrough variant.                                   |

The extension never **crashes** pi when sandboxing fails to set up - it falls back per `PI_SANDBOX_DEFAULT` (default
`warn`: run unwrapped + log per-call). Set `PI_SANDBOX_DEFAULT=block` to refuse to run bash if the wrap itself errors
(strict CI posture).

## Configuration

Two files, both JSONC, both hot-reloaded per tool call:

- `~/.pi/filesystem.json` (or `<repo>/.pi/filesystem.json`) - **shared with [`filesystem.ts`](./filesystem.md)**. See
  [`config/pi/filesystem-example.json`](../filesystem-example.json) and the `filesystem.ts` deep doc for the full
  schema; this section only covers what the kernel sandbox does with the unified policy.
- `~/.pi/sandbox.json` (or `<repo>/.pi/sandbox.json`) - **sandbox-only knobs**: `network`, `unixSockets`, `flags`. See
  [`config/pi/sandbox-example.json`](../sandbox-example.json).

File resolution order, additive within categories:

1. Built-in defaults (deny-all network, no socket bypass, all flags off, depth 3).
2. User: `~/.pi/{filesystem,sandbox}.json`.
3. Project: `<repo>/.pi/{filesystem,sandbox}.json`.
4. Env-var overlay: `PI_SANDBOX_NESTED`, `PI_SANDBOX_WEAKER_NET`, `PI_SANDBOX_EXTRA_ALLOW_DOMAIN`.
5. Persona overlay: the active persona's resolved `writeRoots` are merged into `filesystem.write.allow.paths` so the
   kernel sandbox sees the same write surface the in-process gate sees.

The extension explicitly does **not** read `~/.srt-settings.json` (the path the standalone `srt` CLI uses). Pi reads its
own files so a developer running `srt` from a shell prompt keeps a separate policy.

### How the policy is translated

[`config-translate.ts`](../../../lib/node/pi/sandbox/config-translate.ts) builds the ASRT `SandboxRuntimeConfig` from
the unified policy:

- macOS: `read.deny.basenames` / `read.deny.segments` are lifted to `**/<glob>` patterns sandbox-exec accepts natively.
  A deny rule pointing at a not-yet-existing file is **silently dropped** by sandbox-exec - this is reported in
  `/sandbox`'s lossy-translation section so it's not invisible. Per plan section 9.20 the in-process gate in
  [`filesystem.ts`](./filesystem.md) still blocks them lexically.
- Linux: bwrap accepts only literal paths.
  [`linux-rules-compile.ts`](../../../lib/node/pi/sandbox/linux-rules-compile.ts) walks the search roots (cwd + persona
  writeRoots) with `rg --files --hidden --no-ignore-vcs --max-depth N` and turns each basename / segment rule into the
  set of literal paths it currently matches. Re-run after a `git checkout` or a fresh dotfile commit via
  `/sandbox-rescan`. Default depth `3`, override via `flags.linuxRuleDepth` (clamped 1..10).
- `~/.pi` is auto-added to `filesystem.write.allow.paths` so any extension that ever writes through a wrapped shell
  doesn't EPERM. This is cheap insurance - paths under it are pi-internal session/scratch files anyway.

## Slash commands

- `/sandbox` - print the active config grouped by source, platform info, dependency status, current proxy ports, last
  five violations, and (Linux) the lossy-translation report from rule compilation.
- `/sandbox-allow <domain>` - add a domain to `network.allow`. Scope auto-detects (project if `.pi/` exists, else user).
- `/sandbox-deny <domain>` - same for `network.deny`.
- `/sandbox-allow-write <path>` - add a path to `filesystem.write.allow.paths`. Confirms with a UI prompt because it
  weakens policy.
- `/sandbox-violations [--net | --fs | --unix-socket]` - dump up to 50 most-recent records from
  `~/.pi/sandbox-violations.log`. Filter by violation kind. The log is JSONL with size-rotation (5 MiB) so an audit
  trail survives a pi crash.
- `/sandbox-rescan` - re-run the Linux rule compilation. macOS prints a no-op message.
- `/sandbox-recheck` - re-run dependency detection (`bubblewrap`, `socat`, `ripgrep`). Useful after
  `apt install bubblewrap` without restarting pi.
- `/sandbox-disable` - session-only bypass with a yellow warning notify and the strikethrough statusline badge. Cleared
  on `session_shutdown`. Does **not** write a config file.

Deliberately omitted: `/sandbox-allow-read <path>` to add an `allowRead`-within-deny override. Footgun-shaped; users
edit `~/.pi/filesystem.json` by hand for that.

## Network ask-callback

When sandboxed bash hits a non-allowlisted domain, ASRT fires a `SandboxAskCallback`. The extension routes the callback
through the parent session's `ctx.ui.select` via the [`active-ui.ts`](../../../lib/node/pi/active-ui.ts) singleton, so
subagent-triggered prompts surface in the parent's terminal rather than dead-ending in `hasUI: false`. Non-UI fallback
is `PI_SANDBOX_NETWORK_DEFAULT` (default `deny`).

The v1 callback offers a simple three-way choice (allow once, allow `<host>` for this session, deny). The richer
six-option dialog (auto-write to `~/.pi/sandbox.json` etc.) is wired up in Phase 4 - see plan section 7.

Auto-mode (`/bash-auto`) does **NOT** skip the network prompt. Network access is too easy to abuse to cover behind an
"allow everything" toggle.

## Statusline badge

State is published via [`session-flags.ts`](../../../lib/node/pi/session-flags.ts)' `setSandboxState` and rendered by
[`statusline.ts`](./statusline.md):

| State                                                   | Render                                        |
| ------------------------------------------------------- | --------------------------------------------- |
| Sandbox on, deps OK, no auto-mode                       | `🛡️`                                          |
| Sandbox on + auto-mode on                               | `⚡🛡️` (defense-in-depth visible at a glance) |
| Sandbox bypassed via `/sandbox-disable`                 | `🛡️` (strikethrough) plus warning color       |
| Identity-wrapped (deps missing or unsupported platform) | `🛡️?` plus dim color                          |
| `PI_SANDBOX_DISABLED=1`                                 | `🛡️·off`                                      |

## Composition with other extensions

- **`bash-permissions.ts`**: runs FIRST in the `tool_call` chain (alphabetical-directory order ensures it). The approval
  dialog sees the user's original command; sandbox.ts then rewrites `event.input.command` to `srt -- <cmd>`. The
  original command is preserved on `event.input[SANDBOX_ORIGINAL_SYMBOL]` for transcript renderers / `/bash-history`
  consumers.
- **`filesystem.ts`**: shares the same `~/.pi/filesystem.json`. The in-process gate matches lexically and runs inside
  pi's Node process; the kernel sandbox enforces by realpath at the syscall layer. Symlink-out-of-workspace cases will
  disagree (the kernel follows the symlink, the in-process gate doesn't); the divergence is documented as a known
  limitation - fix shipped separately if needed.
- **`persona.ts`**: persona's resolved `writeRoots` are merged into `filesystem.write.allow.paths` at policy-load time
  AND publish to [`sandbox/active.ts`](../../../lib/node/pi/sandbox/active.ts) so a `/persona switch` mid-session fires
  `SandboxManager.updateConfig()` before the next bash spawn (the bash hook awaits `activeReconfigure()` to avoid
  TOCTOU). Existing bash children keep their old policy until they exit.
- **`bg-bash.ts`**: Phase 4 routes `bg_bash` through [`wrapper-slot.ts`](../../../lib/node/pi/sandbox/wrapper-slot.ts)'s
  `requestSandboxWrap`, which delegates to the same `SandboxManager` singleton. The slot is `globalThis`-anchored so it
  works across pi's per-extension jiti module copies. Today (Phase 3) bg-bash hasn't been wired up yet, but the slot is
  registered on extension load so the wiring lands cleanly.
- **Subagents** (`runOneShotAgent`): the extension registers `sandboxFactoryHookOnly` via
  [`subagent-extension-injection.ts`](../../../lib/node/pi/subagent-extension-injection.ts), so spawned children also
  wrap their bash calls through the same shared `SandboxManager` (subagents are in-process; the singleton + active
  config + UI bridge + wrapper slot are all shared). The factory mounts ONLY the `tool_call` handler - no slash
  commands, no statusline glue.

## Environment variables

| Variable                        | Default | Effect                                                                                                                                                |
| ------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_SANDBOX_DISABLED`           | unset   | bypass entirely; identity-wrap. Statusline `🛡️·off`.                                                                                                  |
| `PI_SANDBOX_DRY_RUN`            | unset   | log the wrapped command but pass the original through (for debugging the wrap pipeline).                                                              |
| `PI_SANDBOX_DEFAULT`            | `warn`  | fallback when `wrapWithSandbox` itself errors: `warn` (run unwrapped + log per-call), `allow` (run unwrapped silently), `block` (refuse to run bash). |
| `PI_SANDBOX_NETWORK_DEFAULT`    | `deny`  | non-UI default for the network ask-callback (`pi -p` mode): `deny` (silent block) or `allow` (silent admit).                                          |
| `PI_SANDBOX_NESTED`             | unset   | enable `flags.weakerNestedSandbox` for users running pi inside Docker / nested containers.                                                            |
| `PI_SANDBOX_WEAKER_NET`         | unset   | enable `flags.weakerNetworkIsolation` (macOS Go-TLS escape hatch for `gh` / `gcloud` / `terraform` / `kubectl`).                                      |
| `PI_SANDBOX_EXTRA_ALLOW_DOMAIN` | unset   | additive comma-separated list of domains merged into `network.allow`.                                                                                 |
| `PI_SANDBOX_ALLOW_ROOT`         | unset   | allow the extension to load when pi runs as root. Off by default per plan section 6.                                                                  |
| `PI_INSIDE_DOCKER`              | unset   | hint platform.ts that pi is inside a container; surfaces a recommendation to enable `flags.weakerNestedSandbox`.                                      |

## Running `pi -p` in CI

Default-on plus `PI_SANDBOX_NETWORK_DEFAULT=deny` will break a CI bootstrap that needs `npm install` / `git push` /
`pip install` etc. Three escalation rungs, prefer the strictest that still works:

```bash
# Rung 1: pre-seed the project allowlist (recommended).
cp .ci/sandbox.json .pi/sandbox.json

# Rung 2: loosen the network gate for the run, keep filesystem enforcement.
export PI_SANDBOX_NETWORK_DEFAULT=allow

# Rung 3: nuclear option for ephemeral CI containers (also matches running
# inside Docker when nested-namespace support is missing).
export PI_SANDBOX_DISABLED=1
```

The REFERENCE.md `Pi extension configuration` table is the canonical list of these variables across runs.

## Manual host smoke

The sandbox cannot be exercised under Docker (the test image lacks unprivileged user namespaces with the right
capabilities). Run these on the host after every change to `sandbox.ts` / `config-translate.ts` /
`linux-rules-compile.ts`.

### macOS

```bash
# 1. Confirm sandbox-exec + ripgrep are present.
pi /sandbox-recheck
# Expect: deps OK

# 2. From a model turn (or `pi -p`):
#    > read ~/.ssh/id_rsa
#    Expect: filesystem gate prompts in-process. Choose Deny.
#    > bash -c 'cat ~/.ssh/id_rsa'
#    Expect: bash-permissions prompts; allow once. Sandbox runs the wrapped
#    command. The cat itself prints `EPERM` from the syscall.
pi /sandbox-violations --fs
# Expect: a row for the deny-read attempt.
```

### Linux

```bash
# 1. Confirm bubblewrap, socat, ripgrep are present.
pi /sandbox-recheck

# 2. Network deny posture (default-on, deny-all):
pi -p 'bash -c "curl -s https://example.com"'
# Expect: connection blocked at the proxy layer; non-zero exit.

# 3. Allow github.com and confirm:
pi /sandbox-allow github.com
pi -p 'bash -c "curl -s https://github.com/robots.txt | head -3"'
# Expect: succeeds.

# 4. Filesystem read gate (smuggled through bash):
pi -p 'bash -c "cat ~/.ssh/id_rsa"'
# Expect: EPERM. /sandbox-violations --fs shows the row.
```

If you don't have a host to run these on (e.g. you only have a Docker dev container), open a follow-up issue and link
the Phase 3 PR; do NOT mark Phase 3 as fully verified until the host smoke runs green.

### Library-level smoke (no model turn required)

This short Node one-liner exercises the load → translate → ASRT-init → wrap → reset pipeline against the example configs
without spawning pi. Useful as a fast pre-flight after touching any of the lib helpers; it caught a real signature
mismatch on the Phase 3 author's macOS host (`SandboxManager` is a singleton object, not a constructor):

```bash
node --experimental-strip-types -e "
(async () => {
  const fs = await import('node:fs/promises');
  const strip = (s) => s.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  const sandboxRaw = strip(await fs.readFile('config/pi/sandbox-example.json','utf8'));
  const fsRaw      = strip(await fs.readFile('config/pi/filesystem-example.json','utf8'));
  const { loadSandboxConfig }   = await import('./lib/node/pi/sandbox/config-load.ts');
  const { loadFilesystemPolicy }= await import('./lib/node/pi/filesystem-policy/load.ts');
  const { translateToASRT }     = await import('./lib/node/pi/sandbox/config-translate.ts');
  const sandbox = loadSandboxConfig([{ source: 'smoke', raw: sandboxRaw }], {});
  const fsRes   = loadFilesystemPolicy([{ source: 'smoke-fs', raw: fsRaw }]);
  const { config } = translateToASRT({
    policy: fsRes.policy, sandbox: sandbox.config, cwd: process.cwd(),
    mode: process.platform === 'linux' ? 'linux' : 'darwin',
  });
  const asrt = await import('@anthropic-ai/sandbox-runtime');
  await asrt.SandboxManager.initialize(config, async () => ({ allow: false, reason: 'smoke' }), false);
  console.log('enabled:', asrt.SandboxManager.isSandboxingEnabled());
  const w = await asrt.SandboxManager.wrapWithSandbox('echo hi');
  console.log('wrap-prefix:', JSON.stringify(w).slice(0, 80));
  await asrt.SandboxManager.reset();
  console.log('OK');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
"
```

Expected output on a supported platform:

```text
enabled: true
wrap-prefix: "env SANDBOX_RUNTIME\=1 TMPDIR\=/tmp/claude ...
OK
```

This was run successfully on macOS by the Phase 3 author against the shipped example configs; it does NOT exercise
actual syscall denial (still requires the model-turn smoke above) but proves the wiring + ASRT-API surface is intact.

## Known limitations (v1)

- DNS-over-UDP exfil is not blocked (`dig @8.8.8.8 ...`). ASRT proxies HTTP/HTTPS/SOCKS5 but not raw UDP - documented as
  future work in
- A long-running `bg_bash` job started under sandbox-config-A keeps that policy until it exits, even if the user later
  edits `.pi/sandbox.json`. `updateConfig()` only affects new spawns. Plan section 9.9.
- macOS `sandbox-exec` silently drops `write.deny.paths` rules pointing at not-yet-existing files; Linux/bwrap enforces
  them via overlay (EROFS on the write). Plan section 9.20. The lossy-translation report in `/sandbox` flags inert rules
  per platform.
- Symlink-out-of-workspace cases disagree between the in-process gate (lexical resolve) and the kernel sandbox
  (realpath). Documented; fix deferred.
- ASRT is `0.0.x` research preview - the runtime API may break across minor bumps. The dep is pinned exact in
  `package.json`; a bump that drops a field surfaces as a typecheck error in `config-translate.ts`.
- MCP server sandboxing is out of v1 scope; see
