# avatar

A reactive avatar widget for pi. A small sprite sits above the editor and reacts to what the agent is doing; the model
can also drive its facial expression with an inline `[emote:NAME]` marker for roleplay. The committed default avatar is
a kaomoji (ASCII) set; PNG art can be dropped in per set for terminals that support inline images.

The pi-coupled glue (widget, animation timers, event wiring) lives in [`avatar.ts`](./avatar.ts). All the pure logic -
config layering, model → set glob resolution, marker parsing, escape encoders, PNG sizing, terminal detection - lives
under [`../../../lib/node/pi/avatar/`](../../../lib/node/pi/avatar) and is unit-tested by
[`../../../tests/lib/node/pi/avatar/`](../../../tests/lib/node/pi/avatar).

## Behaviour

Two independent things drive the avatar.

### Activity states (automatic)

Lifecycle events animate the sprite:

| State     | Trigger                                                               | Animation                           |
| --------- | --------------------------------------------------------------------- | ----------------------------------- |
| `hi`      | ~500 ms after session start                                           | held, then falls back to `idle`     |
| `idle`    | nothing happening                                                     | base frame with an occasional blink |
| `wait`    | `agent_start` (prompt sent, no token yet)                             | base frame with an occasional swap  |
| `think`   | `thinking_start` / `thinking_delta`                                   | base frame with an occasional swap  |
| `talk`    | assistant `text_delta`                                                | mouth cycles at `talkTickMs`        |
| `read`    | `read` tool, or any tool finishing cleanly                            | frame cycle at `cycleMs`            |
| `write`   | `write` / `edit` / `apply_patch` tools                                | frame cycle at `cycleMs`            |
| `tool`    | any other tool starting                                               | frame cycle at `cycleMs`            |
| `debug`   | `grep` / `glob` / find / list, or bash search/find/list/`git` inspect | frame cycle at `cycleMs`            |
| `plan`    | `todo_write` / `update_plan`                                          | frame cycle at `cycleMs`            |
| `fetch`   | `fetch` / web fetch/search, or bash `ai-fetch-web`                    | frame cycle at `cycleMs`            |
| `failure` | a tool finishing with an error                                        | held, then falls back to `idle`     |
| `compact` | `session_before_compact`                                              | held until compaction finishes      |

### Emotion overlay (LLM-triggered)

The model emits a self-closing `[emote:happy]` marker inline in its reply. The marker is:

- **stripped from the visible text** during streaming (`message_update`), so the user never sees it;
- **scrubbed from history** before each provider request (`context`), so the model never sees - and starts echoing - its
  own past markers;
- used to switch the avatar to that emotion's sprite for `emoteHoldMs`, overriding the activity animation, then the
  avatar returns to reflecting activity. Set `emoteHoldMs` to `0` (or negative) to hold the response emotion until the
  next turn instead - handy for roleplay.

A system-prompt addendum (`before_agent_start`) teaches the model the syntax and the emotion vocabulary discovered in
the active set. This reuses the exact three-hook pattern from [`color-tags`](./color-tags.md). The addendum is injected
**only under an active `roleplay: true` persona** (the same gate the [`roleplay`](./roleplay.md) extension uses):
emotion overlays are pure roleplay flavor, so a coding or no-persona session pays no extra prompt tokens and the model
is never nudged to emit `[emote:]` markers. The activity states above are event-driven and always animate regardless of
persona. Emotions are any frame name in the kaomoji set (or any sprite subdirectory in a PNG set) that is not one of the
activity states above - the shipped kaomoji set defines a wide range (`happy`, `sad`, `angry`, `love`, `cry`, `cool`,
`smug`, `excited`, `mischievous`, `victory`, `mindblown`, `starstruck`, and many more).

### Emote signal (persistence + cross-extension event)

When an assistant message finalizes (`message_end`), the emotes stripped from it are turned into a small signal -
`{ emote, emotes, at }`, where `emote` is the primary (last-named) emotion, `emotes` is every distinct emotion the
message named in first-seen order, and `at` is the finalize timestamp. The signal is consumed two ways:

- **Persisted to session history.** It is written as an `avatar-emote` `custom` session entry via `pi.appendEntry`. The
  entry does not participate in LLM context (the model never sees it), but it survives in the `.jsonl`, so looking back
  at a transcript still shows which emotion each reply carried even though the `[emote:]` marker was stripped from the
  visible text. `/avatar` reports the count logged this session. The pure reader
  [`collectLoggedEmotes`](../../../lib/node/pi/avatar/emote-events.ts) turns a flat entry list back into signals.
- **Published on a cross-extension bus.** It is emitted on a `globalThis`-anchored event bus
  ([`../../../lib/node/pi/avatar/emote-events.ts`](../../../lib/node/pi/avatar/emote-events.ts), the same
  `cross-extension-singleton-pattern` the [avatar-input slot](../../../lib/node/pi/avatar/input.ts) uses). Another
  extension subscribes with `subscribeEmote(listener)` (and unsubscribes on its own `session_shutdown`) to hear each
  message's emotion; `getLastEmote()` returns the most recent signal for a consumer that joins late. The motivating use
  case is a TTS extension that colours its speech with the avatar emotion when its own message named none inline. The
  bus is decoupled both ways: with no subscriber the avatar emits into the void; with the avatar disabled a subscriber
  just never hears anything.

Both the persisted entry and the bus event are gated by `PI_AVATAR_DISABLE_EMOTE_EVENTS` (the avatar still animates
emotions when it is off). They fire whenever an emote is detected, regardless of the active persona - the persona gate
only governs the `[emote:]` prompt addendum, not the avatar's reaction to markers the model emits.

## Rendering

Minimal and scoped to the image protocols worth supporting directly:

- **kitty graphics** (APC `_G`) - kitty, Ghostty.
- **iTerm2 inline images** (OSC 1337 `File=`) - iTerm2, WezTerm.
- **sixel** (DCS `q`) - Windows Terminal (>= 1.22) and other sixel-capable terminals. Unlike the other two, the terminal
  can't decode the PNG itself, so the avatar decodes it, scales it to the on-screen footprint, quantises it to a
  palette, and emits the sixel; sprite transparency is preserved via the sixel background-select flag. The sixel line is
  prefixed with a no-op kitty graphics APC marker (`ESC _Gm=0; ESC \`) so pi-tui's `isImageLine()` treats it as an image
  and skips the width-truncation guard - pi-tui does not recognise raw DCS lines and would otherwise count the
  multi-kilobyte payload as visible columns and crash. Sixel terminals ignore the unknown kitty APC and paint the sixel
  that follows.
- **halfblock** (opt-in, truecolor) - any terminal with 24-bit colour, including the ones with no image protocol at all
  (plain xterm, the VS Code integrated terminal, inside `tmux` / `screen`). The avatar decodes the PNG, resizes to
  `size` cells wide by `2 * rows` pixels tall, and packs each cell as a Unicode upper-half block (`U+2580 ▀`) with a
  truecolor foreground (top pixel) and background (bottom pixel); per-half transparency is honoured by switching to the
  lower half block (`U+2584 ▄`), a default-bg space, or the default-bg SGR (`49`). Output is plain styled text so it
  costs no special cursor handling and slots in next to the kaomoji panel. Auto-detection never picks this; enable it
  explicitly with `render: "halfblock"` or `PI_AVATAR_RENDER=halfblock`.
- **kaomoji (ASCII)** fallback - everything else, including inside `tmux` / `screen`.

Detection is environment-based (`KITTY_WINDOW_ID` / `GHOSTTY_RESOURCES_DIR` / `TERM_PROGRAM` → kitty; `ITERM_SESSION_ID`
/ `WEZTERM_PANE` / `TERM_PROGRAM` → iterm2; `WT_SESSION` → sixel). kitty / iTerm2 win when more than one marker is
present. When `$TMUX` is set (or `TERM` is `tmux*` / `screen*`) auto-detection conservatively returns kaomoji because
outer-terminal env markers are typically scrubbed across panes; force the protocol with `render` / `PI_AVATAR_RENDER`
when you know what the outer terminal is (see "tmux / screen" below). The kaomoji set is also used on an image-capable
terminal whenever the resolved sprite set ships no PNG frames (or a PNG can't be decoded for the sixel path), so the
avatar always renders. Override detection with the `render` config key or `PI_AVATAR_RENDER`.

### tmux / screen

Image protocols work through tmux when the user explicitly forces one (`render: "kitty"` / `"iterm2"` / `"sixel"`, or
`PI_AVATAR_RENDER=...`). The renderer wraps the kitty APC / iTerm2 OSC 1337 / sixel DCS payload in tmux's DCS
passthrough envelope (`ESC P tmux ; <doubled-inner-ESCs> ESC \`); tmux strips the envelope and forwards the payload to
the outer terminal verbatim. Only the image escape is wrapped - surrounding CSI cursor controls and DECSC/DECRC stay
tmux-native so the multiplexer's own cursor tracking still works.

Requirements:

- tmux >= 3.3 with `set -g allow-passthrough on` (without this tmux drops the wrapped payload).
- An outer terminal that speaks the chosen protocol (kitty / Ghostty for `kitty`; iTerm2 / WezTerm for `iterm2`; Windows
  Terminal >= 1.22, foot, xterm with sixel, etc. for `sixel`).
- For tmux to forward outer-terminal env markers into new panes (informational; auto-detect through tmux is still off):
  `set -ga update-environment "KITTY_WINDOW_ID GHOSTTY_RESOURCES_DIR ITERM_SESSION_ID WEZTERM_PANE WT_SESSION TERM_PROGRAM"`.

If you'd rather keep the avatar self-contained inside tmux, `render: "halfblock"` is the recommended choice - it needs
nothing in tmux beyond truecolor (`set -as terminal-features ",*:RGB"`).

In kaomoji mode the widget collapses to the top border rule plus a single `face │ <tool tally>` line (the image modes
keep the multi-line info panel). Set `compact` to `false` to keep the full panel in kaomoji mode too.

## External input (other extensions)

The avatar owns _rendering_; another extension can drive _what it shows_ through a neutral, globalThis-anchored slot
([`../../../lib/node/pi/avatar/input.ts`](../../../lib/node/pi/avatar/input.ts)). Three inputs:

- `emoteSet` - a preferred sprite-set name. The avatar prefers it over its model-glob resolution, so a roleplay cast can
  put its character's face on the avatar. A name with no sprite art falls back gracefully (kaomoji / model-glob set),
  exactly like any other missing set.
- `image` - an arbitrary override image (path + optional width hint) rendered in place of the sprite via the same
  `buildImageFrame` path the sprite frames use. A character portrait or a generated scene. Honoured on the image
  protocols (kitty / iTerm2 / sixel / halfblock); in kaomoji (`ascii`) mode there is nothing to draw a PNG with, so the
  sprite shows instead. The built frame is cached by path + width + protocol so it is not re-decoded every tick.
- `scene` - an _additive_ landscape illustration drawn as a separate full-width banner, **above** or **below** the
  avatar+info row (or **replacing** it) per the `scenePlacement` config. Unlike `image` it does not hide the reactive
  face, so the character's emotions stay visible alongside the scene. The image is scaled down (aspect preserved) to fit
  within `sceneMaxRows`, so a tall shot never floods the widget. A full-width border rule divides the banner from the
  avatar+info row (in addition to the widget's top rule), so the generated scene reads as a distinct region. Image
  protocols only; cached like `image`.

The slot is pure (no pi imports) and decoupled both ways: if no extension writes it the avatar behaves exactly as
before; if the avatar is disabled a writer just updates a slot nobody reads. The avatar re-resolves its set on
`before_agent_start` whenever the slot's revision changed, so a persona / active-character switch repoints the face on
the next turn. Today [`roleplay.ts`](./roleplay.md) is the only writer (gated by `PI_ROLEPLAY_DISABLE_AVATAR`).

## Configuration

Config layers lowest → highest: shipped defaults → `~/.pi/agent/avatar.json` → `<cwd>/.pi/avatar.json`. See
[`avatar/config.example.json`](../avatar/config.example.json) for the full default document.

| Key              | Default                                      | Meaning                                                                          |
| ---------------- | -------------------------------------------- | -------------------------------------------------------------------------------- |
| `enabled`        | `true`                                       | Master switch for the session.                                                   |
| `size`           | `8`                                          | Avatar width in terminal columns.                                                |
| `readingSpeed`   | `4`                                          | Words/sec used to pace talk (reserved).                                          |
| `hideBelow`      | `40`                                         | Hide the widget when the terminal is narrower than this.                         |
| `emoteHoldMs`    | `4000`                                       | Hold (ms) for an `[emote:]` overlay; `<= 0` holds until next turn.               |
| `holdDuration`   | `{ hi: 2000, success/failure: 1200 }`        | Hold (ms) for the transient `hi` / `success` / `failure` states.                 |
| `blinkInterval`  | `[3000, 6000]`                               | Random `[min, max]` ms between idle blinks / think swaps.                        |
| `talkTickMs`     | `120`                                        | Interval (ms) between talk mouth frames.                                         |
| `cycleMs`        | `500`                                        | Frame cycle interval (ms) for read / write / tool / emotion.                     |
| `render`         | `"auto"`                                     | Force a protocol: `auto` / `kitty` / `iterm2` / `sixel` / `halfblock` / `ascii`. |
| `compact`        | `true`                                       | In kaomoji mode, collapse to one `face │ tool tally` line.                       |
| `scenePlacement` | `"above"`                                    | Where a `scene` banner draws: `above` / `below` the avatar row, or `replace` it. |
| `sceneMaxRows`   | `12`                                         | Max rows a `scene` banner may occupy; the image is scaled down to fit.           |
| `emotes`         | `[{ "model": "*", "emote-set": "default" }]` | Glob `model` → emote-set mappings; last match wins. Each may add `overlays`.     |

### Sprite sets

Sets resolve project → user → shipped, falling back to the `default` set:

```text
<cwd>/.pi/avatar/emotes/<set>/
~/.pi/agent/avatar/emotes/<set>/
config/pi/avatar/emotes/<set>/   (default)
```

A PNG set is a directory of state subdirectories of frames (`idle/`, `think/`, `talk/`, …, plus emotion dirs). Frames
load in sorted filename order; frame 0 is the base, frame 1 the blink/swap alternate, and any further frames (`2.png`,
…) extend the cycle for animated states like `talk`. The committed kaomoji set is a single
[`ascii.yaml`](../avatar/emotes/ascii/ascii.yaml) keyed by those same state names plus the emotion names.

The repo commits only the kaomoji set. PNG sprite art under `emotes/` is git-ignored scratch (see
[`avatar/.gitignore`](../avatar/.gitignore)); drop your own PNG set in to light up the kitty / iTerm2 / sixel image
path.

#### Layered (opt-in) kaomoji sets

A set's `ascii.yaml` is not all-or-nothing: kaomoji sets layer in increasing precedence, so an opt-in set adds keys on
top of the default instead of replacing it. For the resolved set `<set>` the loader merges, last wins per key:

```text
config/pi/avatar/emotes/ascii/ascii.yaml   (shared default base)
config/pi/avatar/emotes/<set>/ascii.yaml    (shipped per-set overlay)
<resolved set dir>/ascii.yaml                (project / user override)
```

This lets a set ship just its extra emotes while every default emote (`happy`, `think`, `talk`, …) keeps working.

Compose several overlays at once with an `overlays` list on an `emotes` mapping. The shared default set is always the
base layer; the base `emote-set` resolves as usual (and supplies any PNG art); then each name in `overlays` merges its
kaomoji on top, in the order listed, last wins. Overlays contribute kaomoji keys only - PNG art always comes from the
base `emote-set`. So the full kaomoji merge order is `default` → `emote-set` → each `overlays` entry. For example, a
character set with the mature overlay, or just the default set plus mature:

```json
{ "emotes": [{ "model": "*claude*", "emote-set": "exusiai", "overlays": ["mature"] }] }
{ "emotes": [{ "model": "*", "emote-set": "default", "overlays": ["mature"] }] }
```

One generic overlay ships in the repo:

- [`mature`](../avatar/emotes/mature/ascii.yaml) - a richer intimate-roleplay vocabulary (desire, physical reaction,
  intensity, consensual dynamics, vulnerability, aftercare). It is opt-in by design so it never surfaces in ordinary
  coding sessions; kaomoji are text-only expressions, so every entry renders strictly SFW.

Character-specific overlays are device-local rather than committed: drop a `<character>/ascii.yaml` (and any PNG art) in
your user or project set dir (`~/.pi/agent/avatar/emotes/<character>/` or `<cwd>/.pi/avatar/emotes/<character>/`) and
list it in `overlays`. The loader resolves each overlay name through the same project → user → shipped search, so a set
that ships only PNG art still picks up a sibling `ascii.yaml` for the kaomoji fallback.

## Environment variables

| Variable                         | Effect                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_AVATAR_DISABLED`             | Skip the extension entirely.                                                                                                                      |
| `PI_AVATAR_NO_PROMPT`            | Keep the avatar but drop the `[emote:]` prompt addendum (also auto-dropped outside a `roleplay: true` persona).                                   |
| `PI_AVATAR_RENDER`               | Force a protocol (`kitty` / `iterm2` / `sixel` / `halfblock` / `ascii`); overrides config.                                                        |
| `PI_AVATAR_DISABLE_SCRUB`        | Debug: leave `[emote:NAME]` markers in the visible reply and in history (no strip / scrub). The avatar still reacts. Same as `--avatar-no-scrub`. |
| `PI_AVATAR_DISABLE_EMOTE_EVENTS` | Skip persisting the `avatar-emote` session entry and emitting the cross-extension emote bus event. The avatar still animates emotions.            |

## CLI flags

- `--avatar-no-scrub` - debug toggle: keep the raw `[emote:NAME]` markers in the visible reply and in conversation
  history instead of stripping them from the live render and scrubbing them from context. The avatar still parses the
  markers and reacts to them; only the cleanup is skipped. Resolved at `session_start` and OR-combined with
  `PI_AVATAR_DISABLE_SCRUB`.

## Hot reload

Edit [`avatar.ts`](./avatar.ts) or any helper under [`../../../lib/node/pi/avatar/`](../../../lib/node/pi/avatar) and
run `/reload`. A `/reload` re-runs registration and fires `session_start`, so most state is re-resolved:

- **Config (`avatar.json`) and the resolved sprite / kaomoji set** -- re-read on `session_start` (and on `/avatar on`),
  so a `/reload` picks up edits to either.
- **The mounted widget and its animation timers** -- torn down on `session_shutdown` and rebuilt on the next
  `session_start`, so they always reflect the reloaded module.
- **The model -> emote-set mapping** -- recomputed on `session_start` and on a model change.
- **The `[emote:]` prompt addendum** -- rebuilt every `before_agent_start`, so it tracks the active set without a
  reload.

## Command

`/avatar` reports status (on/off, protocol, active set, emotion vocabulary, and the count of emotes logged this
session). `/avatar off` hides the widget for the session; `/avatar on` re-mounts it.
