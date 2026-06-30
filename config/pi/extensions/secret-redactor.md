# `secret-redactor.ts`

Scrubs credentials out of the **model-bound copy** of the conversation before each provider request, and rehydrates them
back into tool calls on demand through a just-in-time, `bash-permissions`-style approval gate.

## Threat model

Catches **accidental** credential leakage to the provider: the agent runs `cat .env`, `env`, `aws configure list`,
prints a config file, pastes a connection string. It is **not** a defense against an adversarial model deliberately
exfiltrating - that is the job of [`sandbox`](./sandbox.md) (kernel egress) and
[`bash-permissions`](./bash-permissions.md) (command approval). This is defense-in-depth beside them. The design bias is
**precision over recall**: over-redaction silently corrupts the agent's context and is hard to notice, so the extension
only redacts when confident; a missed secret just means this one layer did not catch it.

## Core property: redact the model-bound copy, never destroy the value

Redaction runs in the `context` hook, which hands extensions a **mutable deep copy** of the messages right before each
LLM call. The extension rewrites text in that copy only:

- The real value stays in the displayed transcript, the on-disk session, and the **live shell environment**. So auth'd
  bash commands keep working via `$VAR` / sourced files without the model ever seeing the literal, and nothing is
  unrecoverable.
- Redaction is deterministic, so the model-bound prefix is byte-stable across turns and the prompt cache holds.

Composition note: [`cache-breakpoint`](./cache-breakpoint.md) operates later, on the provider payload in
`before_provider_request`, not on the `context` messages - the two never mutate the same object. Because redaction is
deterministic, the previous-user-message bytes cache-breakpoint relocates onto stay stable.

## Detection

All logic is in pure helpers under [`lib/node/pi/secret-redactor/`](../../../lib/node/pi/secret-redactor); the extension
is wiring only. Two layers ship enabled, one is reserved.

1. **Layer A - prefixed provider tokens** ([`patterns.ts`](../../../lib/node/pi/secret-redactor/patterns.ts)
   `PREFIXED_RULES`). Fixed-prefix tokens (AWS, GitHub / GitLab, OpenAI / Anthropic, Google, Slack, Stripe, SendGrid,
   npm / PyPI / HuggingFace, JWT, PEM private-key blocks). The whole match is the secret; near-zero false positive
   because the prefix anchors them.

2. **Layer B - keyword = value** (`KEYWORD_RULES`). `<sensitive-key> <sep> <value>` (`password`, `secret`, `token`,
   `api_key`, `client_secret`, …) plus `Authorization:` headers and `scheme://user:PASSWORD@host` connection strings.
   Only the **value** capture group is redacted, so the key stays readable. Paired with value guards to hold the
   precision bias: env-var references (`$X`, `${X}`, `process.env.X`, `os.environ[...]`), placeholders (`<your-key>`,
   `xxxx`, `changeme`, `REDACTED`, `...`, all-one-char), and a length floor (`keywordMinLength`, default 8) are skipped.

3. **Layer C - entropy.** Reserved. Ships disabled and is not implemented in this version; the `entropy` config key is
   accepted (so a config that sets it is not rejected) but has no effect.

**Allowlist** (`BUILTIN_ALLOWLIST` plus user `allowlist` regexes) is checked **before** emitting any redaction. Built-in
exemptions: git SHA-1/256, UUID, ISO-8601 timestamps, lockfile integrity hashes (`sha512-…`). A value matching the
allowlist is never redacted even if a rule fires.

### Placeholder + handles

A redacted value is replaced with `[REDACTED:<label>#<handle>]`, where `<label>` is the matching rule id and `<handle>`
is a short, non-reversible hash prefix (`sha256(value)`) - never a slice of the secret. The handle is stable for the
session: the same value always maps to the same placeholder, so the cached prefix is byte-stable and the model can tell
two occurrences are the same secret. The session map lives in
[`store.ts`](../../../lib/node/pi/secret-redactor/store.ts) and is cleared on `session_shutdown`.

### Known limit

Mutations / secrets that flow **through bash** rather than the structured tools are detected only by their text shape -
the extension does not, for example, know that `sed -i` rewrote a file. And a value that looks exactly like a git SHA /
UUID assigned to a sensitive key is allowlisted (treated as not-a-secret); add a custom `rule` if your project assigns
hex-only secrets.

## Just-in-time un-redaction gate (`tool_call`)

Modeled on `bash-permissions`. On every tool call the extension scans the string arguments for known `#handle`
references (the handle hex run is the anchor, so a mangled placeholder from a small model still triggers). Handles that
are already approved pass through; the rest get one **batched** approval prompt naming the secret(s) and previewing the
command:

```text
Reveal secret(s) [stripe-key#1a2b] to this bash call?
  STRIPE_KEY=[REDACTED:stripe-key#1a2b] ./deploy.sh
→ Allow once
→ Allow for this session
→ Deny
```

On approval the handle is **rehydrated** (`#handle` → real value) into `event.input` in place, just before execution -
the subprocess gets the real key, the model still never saw it. "Allow for this session" remembers the handle for later
calls. "Deny" (or no UI) blocks the call with a reason that steers toward `$VAR` / file indirection. Because rehydration
mutates `event.input` and `bash-permissions` matches on its own copy, the secret is not written into the bash approval
log.

### The env-prefix case usually needs no rehydration

The shell keeps the real value, so the model should reference it rather than inline it:
`GITHUB_TOKEN=$GITHUB_TOKEN gh …`, `set -a; source .env; set +a; …`, `AUTH=$(pass show x) curl …`. Rehydration is the
fallback for the residual case where the model only has a redacted literal (a token that appeared in a tool result, not
an env var).

## Reveal to context vs rehydrate to subprocess

Two distinct surfaces:

- **Reveal to context** (`/unredact <handle>`, opt-in `reveal_secret` tool): the value becomes visible to the model
  again in future turns. Implemented by approving the handle in the store, which makes `redactText` stop redacting that
  value everywhere (the memo is cleared so prior messages re-evaluate).
- **Rehydrate to subprocess** (the JIT gate's "Allow for this session"): the value flows into command arguments at
  execution time **without** being revealed to the model's context. Tracked in a session-scoped set separate from the
  store's approvals.

## Commands

- `/unredact <handle>` - confirmation-gated reveal of a redacted secret to the model (handle completion offered).
- `/secret-redactor` - list secrets redacted this session (label + handle + state `redacted` / `rehydrate-ok` /
  `revealed`, **never** the value) and the active layer / rule / allowlist counts.

## Config (`~/.pi/agent/secret-redactor.json` + `<cwd>/.pi/secret-redactor.json`, JSONC, stacked)

```jsonc
{
  "layers": { "prefixed": true, "keyword": true, "entropy": false },
  "rules": [{ "id": "acme-api-key", "pattern": "ACME-[0-9a-f]{32}" }],
  "allowlist": ["\\bACME-PUBLIC-[0-9a-f]+\\b"],
  "keywordMinLength": 8,
}
```

- `rules` augment the built-in corpus. A pattern with a **capture group** redacts the value (group 1) and gets
  keyword-style value guards; a group-less pattern is treated like a prefixed token (whole match). The `id` becomes the
  placeholder label. Invalid regex / missing fields produce a one-time warning and skip the rule (the turn never
  breaks). A user regex runs on every text part, so a catastrophically-backtracking pattern is a self-inflicted DoS.
- `allowlist` regexes exempt a matched value (the false-positive escape hatch).
- Project config stacks on top of global. See [`secret-redactor-example.json`](../secret-redactor-example.json).

## Environment variables

- `PI_SECRET_REDACTOR_DISABLED=1` - skip the extension entirely.
- `PI_SECRET_REDACTOR_VERBOSE=1` - notify a per-turn redaction count (never the value).
- `PI_SECRET_REDACTOR_TRACE=<path>` - append one line per config-load / redaction / rehydration decision (handle +
  label, never the value). The primary observability, since redaction is invisible in the displayed transcript.
- `PI_SECRET_REDACTOR_REVEAL_TOOL=1` - register the model-callable `reveal_secret` tool (off by default; the baseline
  posture is a blind model that asks in prose, with the user running `/unredact`).
- `PI_SECRET_REDACTOR_REHYDRATE_DEFAULT=allow` - in non-interactive runs (`pi -p`, subagents), rehydrate without a
  prompt instead of blocking. Default is to block.

## Statusline

A quiet `🔒 N redacted` appears for the session once any secret has been scrubbed (`N` = distinct secrets seen).

## Hot reload

Edit [`secret-redactor.ts`](./secret-redactor.ts) or any helper under
[`lib/node/pi/secret-redactor/`](../../../lib/node/pi/secret-redactor) and run `/reload`. Config is re-read at the next
`session_start` (a `/reload` alone does not re-trigger `session_start`).
