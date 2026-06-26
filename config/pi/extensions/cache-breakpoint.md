# `cache-breakpoint.ts`

Relocate the conversation prompt-cache breakpoint off volatile, reminder-bearing tail messages on anthropic-style
providers, so per-turn `<system-reminder>` injection stops busting the conversation cache.

## The failure mode it fixes

Anthropic-style providers cache the request prefix up to explicit breakpoints. Pi places three: the system block, the
last tool, and the **last user/toolResult message** ("to cache conversation history" -
`packages/ai/src/api/anthropic-messages.ts`; on Bedrock a `cachePoint` block pushed onto the last user message in
`packages/ai/src/api/bedrock-converse-stream.ts`).

Several extensions (`todo`, `scratchpad`, `bg-bash`, `context-budget`, `roleplay`) splice an ephemeral
`<system-reminder id="…">` onto that same last message every turn via
[`context-reminder.ts`](../../../lib/node/pi/context-reminder.ts). The reminder is regenerated fresh each request and
**never persisted**, so next turn that message is in history without it. Because the only conversation breakpoint sits
on that message, the cached prefix always ends with content the next turn no longer reproduces -> the conversation cache
never gets a read hit. `cacheRead` collapses to just system+tools and the **entire conversation re-writes at the 1.25x
cache-write rate every turn** - an O(n) cost blow-up that grows with the session. One real Bedrock/opus session hit
~$32, 90% of it cache-write (4.6M write tokens), with `cacheRead` frozen at the static system+tools prefix from the
first reminder onward.

This is the documented trap in [`AGENTS.md`](./AGENTS.md) ("Auto-injecting state every turn"): the
volatile-state-on-the-tail design keeps the _system prompt_ byte-stable, but the single conversation breakpoint riding
the same tail is the remaining hole. This extension closes it.

## What it does

On `before_provider_request`, when the tail message carries a reminder, it gets the breakpoint **off** the ephemeral
content via two strategies, best-first:

1. **Aggregate (primary).** Lift the `<system-reminder>` block(s) to a trailing position _past_ a breakpoint placed on
   the tail's **real** content, so the real content (e.g. a large tool result) caches immediately and only the reminder
   rides uncached.
   - **Anthropic:** the reminder is already a sibling text block -> set `cache_control` on the last non-reminder block.
   - **Bedrock:** the reminder is nested _inside_ the `toolResult` content member, so un-nest it into a trailing sibling
     `text` block and insert the `cachePoint` between: `[{toolResult: real}, {cachePoint}, {text: reminder}]`. This
     mixed shape is accepted by Bedrock Converse and caches the real prefix (validated live against the Converse API: a
     `[toolResult, cachePoint, text]` request read back the exact prefix a `[toolResult, cachePoint]` request had
     written).
2. **Relocate-to-prev (fallback).** When the tail can't be split cleanly (no real content survives extraction, or no
   cacheable host on the previous step), move the breakpoint onto the **previous** user message
   - always reminder-free and byte-stable. The newest turn rides uncached and folds into the cache one turn later.

Both strategies **relocate** rather than add a breakpoint, so pi stays at three breakpoints (under the four-checkpoint
ceiling), and the fix keys off the `<system-reminder` marker the shared helper emits, so it covers every tail-injecting
extension at once.

The aggregator's win is largest in sessions with a **persistently-active reminder** (background `bg_bash` jobs, long
`todo` plans): there the tail is reminder-bearing every turn, so relocate-to-prev's one-turn-late caching would recur
each turn, whereas the aggregator caches the newest real content immediately. (It is the reminder's _ephemerality_, not
its volatility, that poisons the cache - even a static plan collapses the read - which is why the marker gate fires for
all of them.)

## Composition (other `before_provider_request` listeners)

- `llama-thinking-budget` - injects a thinking budget into OpenAI-compatible payloads; only fires when a reasoning
  signal is present, never touches `messages` cache markers. No overlap.
- `persona` - model/tool overlay; does not rewrite message cache markers.

This extension only mutates `payload.messages[].content` cache markers and only on anthropic-style payloads, so the
three coexist. Order is not significant: it reads the assembled `messages` regardless of who else ran.

## Detection (in `lib/node/pi/cache-breakpoint.ts`)

`relocateTailCacheBreakpoint(payload)` walks the payload and returns `{ changed, style?, reason }`, mutating in place
when it acts:

1. Find the last `role: "user"` message; require array `content`.
2. Detect style from markers on that tail: a `cachePoint` content block -> `bedrock`; a block carrying `cache_control`
   -> `anthropic`; neither -> **no-op** (this is where OpenAI-compatible / local llama.cpp payloads land - they are
   never touched).
3. Only act when the tail is **volatile** - its serialized content contains the `<system-reminder` marker. A clean tail
   caches correctly where pi placed it, so it is left alone (`reason: tail-not-volatile`).
4. **Aggregate (primary, `reason: aggregated`).**
   - **bedrock** (`aggregateBedrockTail`): walk the tail's blocks; lift `<system-reminder` text out of each
     `toolResult.content` member and out of any top-level sibling text block, reuse pi's `cachePoint` (preserving `type`
     / `ttl`), and rebuild the tail as `[…real blocks…, cachePoint, …reminder text…]`. Bails to the fallback if
     extraction would empty a `toolResult` or leave no real content.
   - **anthropic** (`aggregateAnthropicTail`): strip `cache_control` from every block and set it on the last
     **non-reminder** block, leaving trailing reminder blocks uncached. Bails if there's no real block or the last real
     block isn't a cacheable type.
5. **Relocate-to-prev (fallback, `reason: relocated`).** Move the breakpoint onto the previous `role: "user"` message.
   - **bedrock**: strip every `cachePoint` from the tail, push one onto the previous message's content.
   - **anthropic**: strip `cache_control` from the tail and set it on the previous message's last cacheable block,
     converting string content to a text block first. Transactional: if the previous message has no cacheable block,
     leave pi's breakpoint untouched rather than drop it.

The cross-turn invariant the helper guarantees: whatever ends up inside the cached prefix carries **no** reminder, so it
is byte-stable next turn (the ephemeral reminder, regenerated each request, always rides outside the breakpoint) and the
cached prefix grows monotonically.

## Environment variables

- `PI_CACHE_BREAKPOINT_DISABLED=1` - skip the extension entirely (guarded at the top of the factory, nothing registers).
- `PI_CACHE_BREAKPOINT_TRACE=<path>` - append one line per request:
  `<changed|no-op> style=<bedrock|anthropic|none> reason=<reason>`, where `reason` is `aggregated` / `relocated` / a
  no-op reason (`tail-not-volatile`, `no-cache-marker-on-tail`, …). High volume (one line per LLM call); leave unset
  normally.

## Hot reload

Pure shell + helper, no UI / timers / watchers. Editing either `cache-breakpoint.ts` or
`lib/node/pi/cache-breakpoint.ts` is picked up by `/reload` (or on next `pi -p` launch); no session restart needed.
