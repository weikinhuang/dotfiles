# `context-usage.ts`

`/context` opens an interactive, drill-down breakdown of everything occupying the model's context window. Pi's footer
and the [`context-budget`](./context-budget.md) advisory only report an aggregate `N% used`; neither tells you _what_ is
eating the window. `/context` answers that - which `AGENTS.md`, which tool schema, which bash dump, how much retained
reasoning - as a Claude-Code-`/context`-style visual map you can walk into.

Read-only and non-destructive: it never mutates context. To actually shed content use [`context-trim`](./context-trim.md)
(`/context-trim`), [`tool-collapse`](./tool-collapse.md) (`/context-collapse`), or `/compact` (reachable with `c` from
inside the overlay).

## The treemap model

The 10×10 grid (100 cells, each ≈ `window / 100` tokens) is a **treemap that re-scopes on every drill**: it always
represents the _current node_ as 100%, with cells colored by that node's **children**. Drilling into a category
re-normalizes the grid to that category's tokens; a breadcrumb header shows the node's absolute window share
(`System prompt  6.3k · 3.1% of 200k window`). At the root the grid has a free tail (`window − Σ categories`); deeper
levels are fully occupied by their own parts.

Glyphs mirror Claude Code exactly - `⛁` used · `⛀` the single used/free boundary cell · `⛶` free - rendered
space-separated so column alignment holds regardless of glyph render width. Each child gets a distinct theme color
(cycled through `accent`, `success`, `warning`, `error`, `mdLink`, and the `syntax*` tokens); the selected legend row is
bold and brightens its grid cells.

## Category tree

| Top level | Source | Drill-in |
| --- | --- | --- |
| **System prompt** | `getSystemPrompt()` length / 4 | Core instructions & framing · Guidelines · Tool snippets · Appended prompt · **Context files** (each `AGENTS.md` / `CLAUDE.md`, path + bytes) · **Skills index** (each skill) · **Injected addenda** (per-turn todo / scratchpad / memory; see caveat below) |
| **System tools** | `pi.getAllTools()` schemas, serialized | each **active** tool, sorted by size → `parameters schema` vs `description` split; count of configured-but-inactive tools noted |
| **Conversation** | `buildSessionContext(getBranch()).messages` | User · **Assistant** → `Response text` / `Retained reasoning` / `Tool-call args` · **Tool results** → grouped by tool name → top-N largest individual results (with preview) · Bash executions · Injected messages (custom) · Branch / compaction summaries · Images |
| **Free space** | `window − Σ` used categories | (legend row only, at root) |

### Token accounting

All per-category numbers are **chars/4 estimates**, replicating pi's own `estimateTokens` (images counted at 4800
chars), so the breakdown reconciles with `ctx.getContextUsage()`. The provider only reports one real aggregate number,
so an exact per-bucket split is impossible - the header and the reconciliation panel show the real total as
authoritative and the estimate alongside it.

The treemap invariant holds for every node except the root: `node.tokens === Σ children.tokens`. The root's tokens are
the whole context window, so the slack is the free tail.

### Injected addenda (load-order caveat)

The **Injected addenda** bucket is the per-turn content extensions append to the system prompt in `before_agent_start`
(todo / scratchpad / memory / context-budget). The installed pi (0.79.0) does not export `buildSystemPrompt`, so the
base prompt can't be reconstructed directly. Instead the extension captures the prompt as seen by its own
`before_agent_start` handler and diffs the effective prompt against it. Because handlers run in extension load order,
that captured base already includes injections from extensions loaded **before** `context-usage`, so the bucket
reflects injections from extensions loaded **after** it (in practice the big ones - todo / scratchpad / memory). The
diff is never wrong-signed; when no turn has run yet there is no bucket. When pi exports `buildSystemPrompt` (newer
versions) this becomes an exact split, and the addenda are further broken down into labeled blank-line sections via
`splitInjectedAddenda`.

### Retained reasoning

The `Retained reasoning` bucket measures _thinking blocks still present in the context window_, not total reasoning the
model generated. Most providers drop prior-turn reasoning after a turn closes, so this is often near-zero - **but**
preserve-thinking / keep-reasoning setups (some local models pass the full thinking history every turn) keep it, and
then it can be large. It is a first-class bucket, not a footnote. A standalone "generated reasoning" count is not
available: the provider `Usage` pi records exposes only `input / cacheRead / cacheWrite / output`.

## Reconciliation panel (`t`)

Toggles a panel comparing the provider's real total against the summed estimate (with the signed delta), and the last
assistant turn's provider `Usage` split (`input / cacheRead / cacheWrite / output`) plus the cache-hit ratio. When no
post-compaction assistant turn exists yet, the real total is `unknown` and the panel notes that the estimate excludes
the system prompt and tool schemas in that state.

## Content viewer

At the lowest level, leaf nodes that carry raw text open a scrollable content viewer when you press `⏎` on them (the
legend marks an actionable row with a trailing `›`). Viewable leaves are: **context files** (the actual `AGENTS.md`
body), **skills** (the skill body), **tool schemas** (pretty-printed JSON), **tool-result entries** (the actual
output), **guidelines**, **tool snippets**, and **injected addenda sections**. **Core instructions & framing** shows
the full captured base system prompt (it is a size-only remainder that cannot be cleanly sliced out, so the viewer
shows the whole base prompt, of which the other measured sections are subsets). The viewer wraps text to the terminal
width and scrolls with `↑`/`↓`, `PgUp`/`PgDn`, `Home`/`End`; `←` / `esc` returns to the tree. Aggregate buckets
with no single source (per-role conversation totals) are not viewable.

## Keys

| Key | Action |
| --- | --- |
| `↑` / `↓` (`k` / `j`) | move selection (tree) / scroll (content viewer) |
| `⏎` / `→` (`l`) | drill into a category, or open a leaf's content viewer |
| `←` / `esc` / `⌫` (`h`) | back one level (or exit the viewer); close at the root |
| `PgUp` / `PgDn` / `Home` / `End` | page / jump in the content viewer |
| `c` | trigger `ctx.compact()` |
| `r` | recompute / refresh the breakdown |
| `t` | toggle the reconciliation panel |
| `e` | export the full breakdown to `./context-usage-<timestamp>.md` |
| `q` | close |

## Non-TUI fallback

In `print` / RPC modes (`!ctx.hasUI`) there is no overlay, so `/context` emits the same breakdown as a flat, indented
markdown report via `ctx.ui.notify` - identical content to what `e` exports.

## Layering

Pure logic lives under [`lib/node/pi/context-usage/`](../../../lib/node/pi/context-usage) and is vitest-covered:

- `estimate.ts` - the tree builder + the chars/4 estimator (replicated, since `lib/` may not import the pi runtime).
- `grid.ts` - cell → child assignment (re-scoping treemap math).
- `tree.ts` - drill-down navigation state machine.
- `format.ts` - token / percent / breadcrumb formatters (reuses `token-format.ts#fmtSi`).
- `export.ts` - the markdown report.
- `usage.ts` - the `--help` / USAGE string.

The extension shell ([`context-usage.ts`](./context-usage.ts)) only adapts pi APIs (`getSystemPrompt`,
`getSystemPromptOptions`, `buildSystemPrompt`, `buildSessionContext`, `getBranch`, `getAllTools`, `getActiveTools`,
`getContextUsage`) into the plain `BreakdownInput`, renders the pi-tui `ContextOverlay` component, and writes the export
file.

## Environment variables

- `PI_CONTEXT_USAGE_DISABLED=1` - skip the extension entirely.

## Hot reload

Edit [`context-usage.ts`](./context-usage.ts) or any helper under
[`lib/node/pi/context-usage/`](../../../lib/node/pi/context-usage) and run `/reload` in an interactive session. The
`session_shutdown` handler closes any open overlay so `/reload` doesn't leak a focused component.
