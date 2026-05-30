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

| State     | Trigger                                    | Animation                           |
| --------- | ------------------------------------------ | ----------------------------------- |
| `hi`      | ~500 ms after session start                | held, then falls back to `idle`     |
| `idle`    | nothing happening                          | base frame with an occasional blink |
| `wait`    | `agent_start` (prompt sent, no token yet)  | base frame with an occasional swap  |
| `think`   | `thinking_start` / `thinking_delta`        | base frame with an occasional swap  |
| `talk`    | assistant `text_delta`                     | mouth cycles at `talkTickMs`        |
| `read`    | `read` tool, or any tool finishing cleanly | frame cycle at `cycleMs`            |
| `write`   | `write` / `edit` / `apply_patch` tools     | frame cycle at `cycleMs`            |
| `tool`    | any other tool starting                    | frame cycle at `cycleMs`            |
| `failure` | a tool finishing with an error             | held, then falls back to `idle`     |
| `compact` | `session_before_compact`                   | held until compaction finishes      |

### Emotion overlay (LLM-triggered)

The model emits a self-closing `[emote:happy]` marker inline in its reply. The marker is:

- **stripped from the visible text** during streaming (`message_update`), so the user never sees it;
- **scrubbed from history** before each provider request (`context`), so the model never sees - and starts echoing - its
  own past markers;
- used to switch the avatar to that emotion's sprite for `emoteHoldMs`, overriding the activity animation, then the
  avatar returns to reflecting activity. Set `emoteHoldMs` to `0` (or negative) to hold the response emotion until the
  next turn instead - handy for roleplay.

A system-prompt addendum (`before_agent_start`) teaches the model the syntax and the emotion vocabulary discovered in
the active set. This reuses the exact three-hook pattern from [`color-tags`](./color-tags.md). Emotions are any frame
name in the kaomoji set (or any sprite subdirectory in a PNG set) that is not one of the activity states above - the
shipped kaomoji set defines a wide range (`happy`, `sad`, `angry`, `love`, `cry`, `cool`, `smug`, `excited`,
`mischievous`, `victory`, `mindblown`, `starstruck`, and many more).

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
- **kaomoji (ASCII)** fallback - everything else, including inside `tmux` / `screen`.

Detection is environment-based (`KITTY_WINDOW_ID` / `GHOSTTY_RESOURCES_DIR` / `TERM_PROGRAM` → kitty; `ITERM_SESSION_ID`
/ `WEZTERM_PANE` / `TERM_PROGRAM` → iterm2; `WT_SESSION` → sixel). kitty / iTerm2 win when more than one marker is
present. When `$TMUX` is set (or `TERM` is `tmux*` / `screen*`) the avatar falls back to the kaomoji set, because image
passthrough through a multiplexer is **not implemented yet** - that is future work. The kaomoji set is also used on an
image-capable terminal whenever the resolved sprite set ships no PNG frames (or a PNG can't be decoded for the sixel
path), so the avatar always renders. Override detection with the `render` config key or `PI_AVATAR_RENDER`.

In kaomoji mode the widget collapses to the top border rule plus a single `face │ <tool tally>` line (the image modes
keep the multi-line info panel). Set `compact` to `false` to keep the full panel in kaomoji mode too.

## Configuration

Config layers lowest → highest: shipped defaults → `~/.pi/agent/avatar.json` → `<cwd>/.pi/avatar.json`. See
[`avatar/config.example.json`](../avatar/config.example.json) for the full default document.

| Key             | Default                                      | Meaning                                                            |
| --------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| `enabled`       | `true`                                       | Master switch for the session.                                     |
| `size`          | `8`                                          | Avatar width in terminal columns.                                  |
| `readingSpeed`  | `4`                                          | Words/sec used to pace talk (reserved).                            |
| `hideBelow`     | `40`                                         | Hide the widget when the terminal is narrower than this.           |
| `emoteHoldMs`   | `4000`                                       | Hold (ms) for an `[emote:]` overlay; `<= 0` holds until next turn. |
| `holdDuration`  | `{ hi: 2000, success/failure: 1200 }`        | Hold (ms) for the transient `hi` / `success` / `failure` states.   |
| `blinkInterval` | `[3000, 6000]`                               | Random `[min, max]` ms between idle blinks / think swaps.          |
| `talkTickMs`    | `120`                                        | Interval (ms) between talk mouth frames.                           |
| `cycleMs`       | `500`                                        | Frame cycle interval (ms) for read / write / tool / emotion.       |
| `render`        | `"auto"`                                     | Force a protocol: `auto` / `kitty` / `iterm2` / `sixel` / `ascii`. |
| `compact`       | `true`                                       | In kaomoji mode, collapse to one `face │ tool tally` line.         |
| `emotes`        | `[{ "model": "*", "emote-set": "default" }]` | Glob `model` → emote-set mappings; last match wins.                |

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

## Environment variables

| Variable              | Effect                                                                       |
| --------------------- | ---------------------------------------------------------------------------- |
| `PI_AVATAR_DISABLED`  | Skip the extension entirely.                                                 |
| `PI_AVATAR_NO_PROMPT` | Keep the avatar but drop the `[emote:]` prompt addendum.                     |
| `PI_AVATAR_RENDER`    | Force a protocol (`kitty` / `iterm2` / `sixel` / `ascii`); overrides config. |

## Command

`/avatar` reports status (on/off, protocol, active set, emotion vocabulary). `/avatar off` hides the widget for the
session; `/avatar on` re-mounts it.
