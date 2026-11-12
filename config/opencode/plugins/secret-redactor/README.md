# `secret-redactor`

Scrubs credentials out of every model-bound request opencode sends, and rehydrates them into tool calls only after an
approval through opencode's own permission system. Ported from the pi
[`secret-redactor`](../../../pi/extensions/secret-redactor.md) extension, whose threat model and detectors it shares.
Parts: [`server.ts`](./server.ts) (hooks, gate, RPC handlers), [`tui.tsx`](./tui.tsx) (`/secret-redactor` dialog), and
[`rpc.ts`](./rpc.ts). Logic lives in
[`lib/node/opencode/secret-redactor.ts`](../../../../lib/node/opencode/secret-redactor.ts) and
[`secret-redactor-request.ts`](../../../../lib/node/opencode/secret-redactor-request.ts); the detection corpus,
placeholders, and handles come from [`lib/node/pi/secret-redactor/`](../../../../lib/node/pi/secret-redactor/).

## Threat model

It catches **accidental** leakage to the provider: the agent runs `cat .env`, prints a config, or you paste a connection
string. It is not a defense against a model that deliberately exfiltrates; sandboxing and shell permissions are. The
bias is **precision over recall**: over-redaction silently corrupts the agent's context, so the plugin redacts only when
a rule is confident (prefixed provider tokens, `key = value` assignments with value guards, `Authorization` headers,
connection-string passwords). See the pi doc for the full detection reference.

## Redaction

Each session hook that builds a model request is registered separately, because opencode runs one hook per request kind:

| Hook         | Request                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------ |
| `context`    | The agent loop, including tool continuations and subagent child sessions.                  |
| `compaction` | Checkpoint summaries. Without it the summarizer sees real values and the summary persists. |
| `generate`   | Transient `ctx.session.generate` calls from other plugins.                                 |
| `title`      | Session title generation.                                                                  |

Every string the model receives is scanned: system parts (including the `metadata.experimental.instructions` mirror and
`<context>` instruction entries), user / assistant / system message text, unsigned reasoning, tool-call inputs (deep
JSON), tool results (`json` / `text` / `error` values and `content` text items), and compaction summaries. A hit becomes
`[REDACTED:<rule>#<handle>]`, where the handle is a short `sha256` prefix of the value, never a slice of it.

The edits touch only the outgoing copy: the transcript, the database, and the shell keep the real values, so `$VAR` and
sourced-file auth keep working. The walk is copy-on-write and deterministic, so unchanged parts keep their identity and
a given value always maps to the same placeholder, across sessions and restarts; the prompt-cache prefix stays stable.

Hooks are global to the plugin's location, so subagent child sessions are covered. Reveals and the set of handles a
session may rehydrate are tracked per root session, so a subagent shares its parent's view.

## Rehydration gate

When a tool call's input references a placeholder (or a bare `#handle` a small model kept after mangling the rest),
`tool.execute.before` asserts the custom permission action `secret_unredact` for that call, then swaps in the real
value. All secrets in one call are batched into a single prompt, with `<rule>#<handle>` as the resources and save
patterns.

opencode's base policy allows unknown actions, so the plugin inserts `secret_unredact * ask` into every agent's rules,
right after the leading `* * allow` and before configured rules. Your rules therefore still decide:

```jsonc
{
  "permissions": [
    { "action": "secret_unredact", "resource": "github-token#*", "effect": "allow" },
    { "action": "secret_unredact", "resource": "aws-access-key#*", "effect": "deny" },
  ],
}
```

- **Allow once** rehydrates into this call only.
- **Always allow** saves `secret_unredact: <rule>#<handle> -> allow` for the project. The handle is a hash of the value,
  so the approval covers that one secret in later sessions too.
- **Reject** fails the call. A configured `deny` (or no one present to answer) fails it with a message steering the
  model to `$VAR` or file indirection.
- Agents whose policy denies everything (`explore`, `title`, `summary`) deny rehydration.

The TUI renders custom actions generically: the prompt reads `Call tool secret_unredact`, and only the **Always allow**
pane lists the `<rule>#<handle>` patterns. The tool call itself, with its placeholder, shows right above the prompt.

Prefer `$VAR` over rehydration: `GITHUB_TOKEN=$GITHUB_TOKEN gh ...` never needs the gate. Rehydration is the fallback
for a value that appeared only in a tool result.

## `/secret-redactor`

A TUI slash and palette command that lists the secrets redacted in the current session (`<rule>#<handle>` and `redacted`
/ `revealed`, never the value) plus the active config summary. Selecting one and confirming **reveals** it: the value is
sent as plaintext in future requests of this session tree. Reveals live in server memory and reset when opencode
restarts. This replaces pi's `/unredact` and `/secret-redactor`.

## Configuration

Detection settings use the pi `secret-redactor.json` shape (`layers`, `rules`, `allowlist`, `keywordMinLength`) and
stack in this order, later wins for scalars while `rules` and `allowlist` accumulate:

1. Plugin options in `opencode.jsonc` (see [Install](../README.md#install)).
2. `<config dir>/secret-redactor.json`, where the config dir is `$OPENCODE_CONFIG_DIR` or
   `${XDG_CONFIG_HOME:-~/.config}/opencode`.
3. `<project>/.opencode/secret-redactor.json`, then `<location>/.opencode/secret-redactor.json` when they differ.

The JSON files exist because allowlists are mostly per repository (test fixtures, sample keys), and a project can ship
one in its `.opencode/` without touching the user's plugin entry; regex lists also read better in a dedicated JSONC
file. Malformed files, bad regexes, and wrong-typed fields are skipped with a warning in the server log (and the trace
file).

```jsonc
{
  "layers": { "prefixed": true, "keyword": true },
  "rules": [{ "id": "acme-api-key", "pattern": "ACME-[0-9a-f]{32}" }],
  "allowlist": ["^ACME-PUBLIC-[0-9a-f]+$"],
  "keywordMinLength": 8,
}
```

A rule pattern with a capture group redacts only group 1 and gets the keyword value guards; a group-less pattern redacts
the whole match. Scalar knobs also read `OPENCODE_SECRET_REDACTOR_*` overrides, which win over everything:

| Option             | Env override                                  | Default | Effect                                                     |
| ------------------ | --------------------------------------------- | ------- | ---------------------------------------------------------- |
| `enabled`          | `OPENCODE_SECRET_REDACTOR_ENABLED`            | `true`  | `false` disables the plugin.                               |
| `rehydrate`        | `OPENCODE_SECRET_REDACTOR_REHYDRATE`          | `true`  | `false` drops the gate; placeholders reach tools as-is.    |
| `keywordMinLength` | `OPENCODE_SECRET_REDACTOR_KEYWORD_MIN_LENGTH` | `8`     | Minimum value length for keyword rules.                    |
| `trace`            | `OPENCODE_SECRET_REDACTOR_TRACE`              | unset   | Append one line per decision (handles only, never values). |
| `dump`             | `OPENCODE_SECRET_REDACTOR_DUMP`               | unset   | Debug: append each redacted request as a JSON line.        |
| `layers`           | -                                             | both on | `{ "prefixed": bool, "keyword": bool }`.                   |
| `rules`            | -                                             | `[]`    | Extra `{ id, pattern, flags? }` rules.                     |
| `allowlist`        | -                                             | `[]`    | Regexes that exempt a matched value.                       |

Booleans accept `true` / `false` or the dotenv `1` / `0`, `yes` / `no`, `on` / `off` words. `dump` writes whatever the
model receives, so a secret the rules miss lands in that file; use it only for testing.

## Limitations

- Shell permissions run after rehydration, so with a `shell` `ask` rule the shell prompt shows the real command, and its
  **Always allow** may save a prefix that contains the value.
- The handle store lives in server memory. After a restart, a placeholder that survives only inside a compaction summary
  can no longer be rehydrated (the original value is gone from the projected history); the model should use `$VAR`.
- Signed or encrypted reasoning passes through unchanged, since providers reject edited thinking blocks.
- A value shaped like a git SHA or UUID assigned to a sensitive key is allowlisted; add a custom rule for hex-only
  secrets.
- Detection config is read once at load; restart opencode after editing a `secret-redactor.json`.

## Live test

```bash
D="$(./dev/opencode-plugin-smoke.sh dir sr)"
./dev/opencode-plugin-smoke.sh start -n sr \
  -o "secret-redactor={\"trace\":\"$D/trace.log\",\"dump\":\"$D/dump.jsonl\"}" secret-redactor
echo 'GITHUB_TOKEN=ghp_FAKEfakeFAKEfake0123456789abcdefABCD' >"$D/secret.txt"
./dev/opencode-plugin-smoke.sh send sr 'Run: cat secret.txt   Then reply with the token as you see it, prefixed by SEEN:'
./dev/opencode-plugin-smoke.sh wait sr '^ +SEEN:'      # shows REDACTED:github-token#<handle>
grep -c ghp_FAKE "$D/dump.jsonl"                       # 0
./dev/opencode-plugin-smoke.sh send sr 'Run exactly: echo "[REDACTED:github-token#<handle>]" > out.txt'
./dev/opencode-plugin-smoke.sh wait sr 'Permission required'
./dev/opencode-plugin-smoke.sh keys sr Enter            # Allow once
cat "$D/out.txt" "$D/trace.log"                        # real token; ask + rehydrated lines
./dev/opencode-plugin-smoke.sh send sr '/compact'       # trace: redact kind=compaction
./dev/opencode-plugin-smoke.sh stop sr
```
