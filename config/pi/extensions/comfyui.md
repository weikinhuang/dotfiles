# comfyui

A local/remote [ComfyUI](https://github.com/comfyanonymous/ComfyUI) image-generation tool for pi. Registers a
`generate_image` tool the model calls to render an image, an `image_jobs` tool for background generations, and a
`/comfyui` status command. The result is returned inline as a multimodal tool result, so it renders in the terminal and
is visible to vision-capable models.

This is a custom tool, not a replacement for pi's built-in (provider-routed) image generation - pi exposes no
extension-pluggable image-provider hook, so a tool is the integration point, the same shape pi's own
`antigravity-image-gen.ts` example uses.

[`comfyui.ts`](./comfyui.ts) is a thin factory: the registration gate, the workflow capability matrix, and the tool /
command / hook registration. The session-scoped state and the two tool bodies live next door in
[`../../../lib/node/pi/ext/comfyui/`](../../../lib/node/pi/ext/comfyui) - the `ext/` carve-out for helpers that must
import the pi runtime or `sharp`:

- `runtime.ts` - the `ComfyuiRuntime` class that owns the mutable session state (job registry, generation registry,
  ephemeral-collapse overlay, scene-capture budget, statusline slot, auto-download poll timer) and the logic for the
  five lifecycle hooks (`session_start` / `session_tree` / `session_shutdown` / `before_agent_start`) plus the `context`
  hook. The shell's `pi.on(…)` handlers and tool bodies all delegate to it.
- `generate.ts` / `jobs.ts` - the `generate_image` and `image_jobs` tool bodies (each takes the runtime).
- `params.ts` - the `generate_image` TypeBox schema (capability-pruned).
- `render.ts` + `details.ts` - tool-result rendering and the shared `details` shapes.
- `images.ts` - the `sharp` model-facing downscale + bbox-mask synthesis.
- `enhancer.ts` - the opt-in prompt-enhancer subagent wiring.
- `refiner.ts` - the opt-in auto-refine vision-critic subagent wiring (the output-side mirror of `enhancer.ts`).
- `refine-loop.ts` - the shared refine engine wiring (corrective-render primitive + the refiner-aware loop driver).
- `refine-command.ts` - the standalone `/comfyui refine <gX>` body.

All pure logic - config layering + `${ENV}` interpolation, workflow parameter injection, URL building, history /
websocket parsing - lives under [`../../../lib/node/pi/comfyui/`](../../../lib/node/pi/comfyui) and is unit-tested by
[`../../../tests/lib/node/pi/comfyui/`](../../../tests/lib/node/pi/comfyui).

## How a generation runs

1. Resolve config and the named workflow (`workflow` arg, else `defaultWorkflow`).
2. Load and validate the API-format workflow JSON for that name.
3. For edit / img2img, upload each `inputImages` entry via `POST /upload/image` and reference the stored names in the
   workflow's ordered image slots.
4. Inject the prompt / seed / dimensions / etc. into the node ids named by the workflow's input map. Omitted args keep
   the workflow file's baked-in values; an omitted `seed` becomes a fresh random seed only when the workflow maps one.
5. Submit via `POST /prompt` with a generated `client_id`, capturing the `prompt_id`.
6. Poll `GET /history/{prompt_id}` for completion; concurrently stream `GET /ws` progress into the tool's live update
   line. The poll is the source of truth (best-effort - websocket failures, including auth, fall back silently to
   polling), but when the websocket is healthy its completion / error event wakes the poll immediately, so there is no
   up-to-one-second wait between "render finished" and "noticed".
7. Fetch each output via `GET /view`, write the file(s) to `saveDir`, and return them inline with a one-line summary.
   Outputs reported under `images`, `gifs` (animation / video workflows), and `audio` are all collected; the
   server-supplied filename is reduced to its basename before writing, so a path-traversal name can never escape
   `saveDir`. A `PreviewImage`+`SaveImage` pair that emits the same file twice is de-duplicated, keeping the saved
   `output` copy, so one render is never saved or sent to the model twice.

A non-2xx `POST /prompt` (e.g. unknown checkpoint, bad dimension) surfaces ComfyUI's validation body as an `isError`
tool result so the model can self-correct.

## Tool: `generate_image`

| Parameter             | Type    | Notes                                                                                                                                    |
| --------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`              | string  | Positive prompt. Required unless `variationOf` supplies one to reuse.                                                                    |
| `negative`            | string  | Negative prompt.                                                                                                                         |
| `variationOf`         | string  | Reuse a prior generation id (`g3`) as a baseline (workflow / prompt / seed / dims), then override.                                       |
| `refine`              | string  | Refine a prior generation id (`g3`): feed its image into an edit `workflow`; omit `inputImages`.                                         |
| `workflow`            | string  | Named workflow; defaults to `defaultWorkflow`.                                                                                           |
| `width`               | number  | Output width in pixels.                                                                                                                  |
| `height`              | number  | Output height in pixels.                                                                                                                 |
| `aspect`              | string  | Aspect preset (`16:9`, `portrait`, `square`, …) expanded to width/height. Explicit dims win.                                             |
| `steps`               | number  | Sampler steps.                                                                                                                           |
| `cfg`                 | number  | CFG / guidance scale.                                                                                                                    |
| `seed`                | number  | Omit for a fresh random seed; pass a prior seed to reproduce.                                                                            |
| `denoise`             | number  | Denoise strength (img2img), `0`-`1`.                                                                                                     |
| `inputImages`         | array   | Ordered reference image paths for positional img2img / edit workflows, e.g. `["~/in.png"]`.                                              |
| `images`              | object  | Named image inputs keyed by role (`init`, `mask`, …) for role-based workflows. See below.                                                |
| `count`               | number  | Batch size.                                                                                                                              |
| `sendToModel`         | boolean | Override the `sendToModel` config default for this call.                                                                                 |
| `ephemeral`           | boolean | Show the image inline this turn, then collapse the call + image out of context. See below.                                               |
| `background`          | boolean | Submit and return now; collect later via `image_jobs`. Overrides the `background` config default.                                        |
| `enhance`             | boolean | Refine prompt + negative into the workflow's protocol via a subagent first. See below.                                                   |
| `context`             | string  | Background to honor during enhancement (not depicted literally). Only used when `enhance` is on.                                         |
| `autoRefine`          | boolean | After the render, run a vision critic and loop corrective re-renders until it passes or a budget is hit. Forces `count` to 1. See below. |
| `refineCriteria`      | string  | Explicit acceptance criteria for auto-refine (e.g. "full body, facing left"); absent = derived from the prompt. Only with `autoRefine`.  |
| `previewMaxDimension` | number  | Downscale the copy returned to you to this longer-side px cap (file stays full-res). See below.                                          |

Each parameter is injected only if the active workflow's input map names a node for it. Passing an arg the workflow does
not map (or passing `inputImages` to a workflow with no image slots) returns a clear error rather than a silent no-op.
Workflows that declare more than one image slot (see `images` below) accept several ordered reference images; supplying
more images than the workflow has slots is an error, while supplying fewer fills the slots in order and leaves the
remaining slots at their graph-baked image.

`aspect` is a convenience that expands to `width` / `height` at a target pixel budget (the `defaults` area when both are
configured, else ~1 MP), snapped to a multiple of 8. It accepts a named preset (`square`, `portrait`, `landscape`,
`tall`, `wide` / `widescreen`, `cinema`) or a `W:H` / `W x H` ratio. An explicit per-call `width` / `height` overrides
the aspect-derived value, and a workflow that maps neither dimension rejects `aspect` with a clear error (edit graphs
take their size from the reference image).

### Prompt enhancement (`enhance`)

When `enhance` is on, `generate_image` rewrites the positive and negative prompts into the target workflow's native
protocol before submitting, using a one-shot [`comfyui-enhance`](../agents/comfyui-enhance.md) subagent. This lets the
calling model send a loose, natural-language prompt and let the enhancer translate it into, say, comma-separated
Danbooru tags for an anime checkpoint, or expand a terse phrase with composition / lighting / style detail for a FLUX
graph.

- **Opt-in.** Off unless the per-call `enhance` arg or the `enhance` config knob turns it on. Workflows whose
  `promptProtocol` is not plain natural language carry a `recommends enhance` hint in the tool's capability matrix, but
  only while the enhancer is actually installed.
- **Guidance.** The enhancer is handed the workflow's `description`, `tags`, and `promptProtocol`, plus the concatenated
  contents of the global `enhanceGuidanceFile` and the workflow's own `guidanceFile` (global first). Those docs tell it
  how to phrase for this specific image model.
- **Scene context.** The enhancer runs in a fresh subagent and sees no conversation history. The per-call `context` arg
  is the explicit way to hand it scene/continuity to honor (not depict literally). When `enhanceContextChars > 0`, the
  extension also auto-captures up to that many chars of the most recent user/assistant turns and feeds them as a
  `Recent conversation` background block - so the enhancer can enrich even an already-protocol-formatted prompt with
  scene detail without the calling model hand-feeding `context` each call. The explicit `context` arg leads; the
  captured scene follows. It costs extra input tokens per enhance call on the inherited model, so it is off by default.
- **Context.** The per-call `context` arg is passed as background to honor (scene, continuity, character facts) without
  being depicted literally. Ignored when `enhance` is off.
- **Negative.** The enhancer builds on the baseline negative (per-call `negative` ?? `variationOf` ?? `defaults`); its
  returned negative replaces the baseline for the render.
- **Model.** The enhancer inherits the active session model unless `enhanceModel` (`provider/model-id`) points it at a
  cheaper one. It runs synchronously before the render submits, so a slow model both adds latency and is more likely to
  be aborted: in a fast back-and-forth (e.g. roleplay) the parent turn can end before the enhancer finishes, and the run
  has its own `enhanceTimeoutMs` (default 30s) wall-clock cap. Point `enhanceModel` at a fast model to shrink that
  window.
- **Diagnostics.** Failures (`aborted`, `timed out after …ms`, parse failures) always notify, with the abort cause
  disambiguated (a parent-turn cancellation vs the enhancer's own timeout). A successful enhance is silent unless
  `PI_COMFYUI_ENHANCE_DEBUG` is set, which adds a one-line `enhanced → …` notify per render so you can confirm it fired.
- **Best-effort, never blocks.** A missing agent, model-resolution failure, spawn error, non-`completed` stop, or
  unparseable output silently falls back to the original prompt + baseline negative. Set `PI_COMFYUI_DISABLE_ENHANCE` to
  hard-disable it. When the prompt was enhanced, the result echoes the enhanced positive so the model can reuse it via
  `variationOf`; the registry records the enhanced prompt (what was actually rendered).

### Prompt refinement (`autoRefine`)

Where `enhance` improves the **input** (prompt -> protocol) before a render, `autoRefine` improves the **output** (the
pixels) after it. When it is on, `generate_image` renders once, then a one-shot vision critic
([`comfyui-critic`](../agents/comfyui-critic.md)) judges the image against the request and the loop issues corrective
re-renders until the image is accepted or a budget is hit. It is the mirror image of the prompt enhancer: same opt-in
flag shape, same best-effort / never-block / graceful-no-op contract, same pure-engine + `ext`-wiring split.

- **Opt-in.** Off unless the per-call `autoRefine` arg, the per-workflow `refine` override, or the `autoRefine` config
  knob turns it on. Resolution is `per-call autoRefine ?? workflow.refine ?? config.autoRefine`. The `autoRefine` /
  `refineCriteria` params (and the critic's available-action hint) surface only while the `comfyui-critic` agent is
  installed and not env-disabled, mirroring the enhance gating.
- **The critic emits a decision, not coordinates.** A local vision model is good at judging and naming, weak at pixel
  coordinates, so the critic returns a structured decision - `verdict` (`accept` / `revise`), a 0-10 `score`, classified
  `issues`, and a single proposed repair `action` - never a trusted bounding box. The engine validates the proposed
  action against the channels available for this workflow and downgrades it when it is not runnable, so a weak model
  proposing an impossible action can never wedge the loop.
- **Channels.** The always-available text-to-image channels are `reroll` (resubmit the same graph with a fresh seed) and
  `revise_prompt` (re-inject a revised positive / negative, rerolling the seed only when the critic asks); both work on
  any workflow with no extra config. The **companion channels** route a repair to another configured workflow named in
  the source workflow's [`refineWith`](#refinewith-companion-channels) map - `img2img` (whole-image low-denoise polish),
  `inpaint` (a coarse-region masked repaint), `detailer` (auto-detected hands / face / eyes), and `ground` (a named
  target phrase localized in-graph). A companion channel is offered only when its `refineWith` entry resolves to a
  configured workflow; otherwise the engine's class-aware downgrade falls back to a t2i channel (a `bad_hands` defect
  with no detailer rerolls rather than blindly img2img-ing).
- **`count` is pinned to 1.** Auto-refine converges a single image, so a batch request is rendered as one image (noted
  on the result line when the caller asked for more).
- **Best-so-far, never an error.** The loop returns the highest-ranked render (verdict-driven, the `score` only a coarse
  tiebreak), capped by `maxRefineIterations` corrective renders (default 2 => up to 3 renders total), an `accept`
  verdict, a `refineAcceptThreshold` score backstop (default 7), or a score plateau. When the budget runs out without an
  accept, the best-so-far is still returned as a NORMAL (non-error) result with a candid
  `best effort, score N - not fully satisfied` note.
- **Intermediates cost no model context.** The whole loop runs inside the one `generate_image` call, so the intermediate
  renders never become separate persisted tool results - only the final best image enters context. Each intermediate is
  still written to `saveDir`, and the final generation record carries a `refine` journey block (`rounds`, `accepted`,
  `finalScore`, and per-render `action` / `score` / `savedPath`) that `/comfyui gallery <id>` prints. The journey is
  summarized on the result line, e.g. `(auto-refined 2 rounds: reroll -> revise_prompt; accepted, score 8)` appended
  after the usual `Generated 1 image [g7] via "anima" (seed 4412). Saved to <dir>.`
- **Vision required, graceful no-op.** The critic must `read` the saved PNG, so it needs a vision-capable model:
  `refineModel` (`provider/model-id`) points it at one, else it inherits the session model when that has image input. No
  vision model, no agent, a spawn error, a non-`completed` stop, or unparseable output skips refine and returns the
  unrefined render - it never errors a generation. A successful critique is silent unless `PI_COMFYUI_REFINE_DEBUG` is
  set; failures notify regardless. `PI_COMFYUI_DISABLE_REFINE` hard-disables the whole loop.
- **Background composes.** With `background: true` + auto-refine, the loop runs **off-turn inside the detached job**:
  the job's status text shows live progress (`refining 2/3, score 6`) and the `▦ img:N` statusline reflects it; a later
  `image_jobs collect` returns the converged best-so-far, and the gallery record still carries the journey block. The
  managed job is skipped by the auto-download poll (its detached task owns the full lifecycle).
- **Guidance + criteria.** The critic is handed the workflow's `promptProtocol` plus the concatenated global
  `refineGuidanceFile` and the workflow's own `refineGuidanceFile` (global first), telling it what "good" means for this
  model. Acceptance criteria come from the per-call `refineCriteria` arg, else the workflow's `refineCriteria` default,
  else are derived from the prompt.

### Image token economy (`previewMaxDimension`)

Image token cost scales with pixel dimensions, so a large render can dominate a turn's context. When
`previewMaxDimension` is set (per-call arg or config), the copy returned to the model is downscaled so its longer side
is at most that many pixels, preserving aspect ratio; the file written to `saveDir` is always full resolution. Setting
it re-encodes the same pixels at a smaller size (re-encoding format alone would not change the token cost).

- Only still raster images (PNG / JPEG / WebP) are resized; animated GIFs and non-image outputs (audio, video) pass
  through untouched.
- The resize uses `sharp`. If `sharp` fails to load or errors, the full-resolution copy is sent instead - it never
  blocks a render.
- Ephemeral renders are never downscaled: their block is collapsed out of the model's context anyway, so shrinking it
  would only degrade the one-time terminal preview.
- Collected background jobs are downscaled on the way back to the model too, using the config value (collect takes no
  per-call preview arg).

## Background generation

A slow render (many steps, large dimensions, a big batch) can be fired off without blocking the turn by calling
`generate_image` with `background: true`. The tool records a lightweight job and returns the job id immediately, then
runs the whole enhancement → graph-build → submit pipeline **off-turn** so the turn is never blocked on the enhancer LLM
call, image uploads, or the `POST /prompt` round-trip. The detached submit owns its own abort controller + timeout (not
the turn's signal, which is gone the moment the tool returns) and patches the real `prompt_id`, seed, and rendered
prompt onto the job once ComfyUI has queued it; a prep/submit failure marks the job `error` (surfaced on the next
`collect`). Until that patch lands the job sits in `running` with an empty prompt id, which the auto-download poll and
`collect` both treat as "still submitting" rather than a lost prompt. ComfyUI keeps executing it server-side, so nothing
is lost when the turn ends.

This works because ComfyUI queues every `POST /prompt` and persists the result under its `prompt_id`. A background job
is therefore just metadata - the registry holds no process or buffer - and the actual PNGs are fetched on collection.
Because the submit is deferred, a `background: true` call returns before its seed is known, so the start message omits
the seed (the seed is recorded on the job once the submit lands).

To make every generation background by default (e.g. a project of slow renders), set `"background": true` in a
`comfyui.json` layer; the per-call `background` arg still overrides it, so an individual foreground render is `false`.

### Auto-download

When `autoDownload` is on (the default), the extension runs an off-turn timer that polls `/history` for every running
job every `pollIntervalMs` (default `3000`) and fetches the finished PNG(s) to `saveDir` the instant the render
completes - no `image_jobs collect` call needed. The timer starts lazily the first time a background job is submitted,
stops itself once no jobs are running (so a quiet session is not polling forever), and is torn down on
`session_shutdown` / `/reload`. A per-job in-flight guard prevents the timer and a concurrent manual `collect` from
fetching the same job at once (which would double-write its output files).

Auto-download only gets the file **onto disk** - it cannot push the image into the model's context, because an image
enters the conversation only through a tool result the model itself invoked. So if you want the model to _see_ an
auto-downloaded render, it still calls `collect`; that path re-serves the already-saved files from disk inline (it does
not re-fetch from the server). Set `"autoDownload": false` to go back to pull-only collection.

## Generation registry

Every render that lands on disk - foreground, collected background, or ephemeral - is recorded in a per-session
**generation registry** and given a short id (`g1`, `g2`, …). The id is echoed in the result line
(`Generated 1 image [g3] via "anima"…`) so the model can refer back to it. The registry stores the resolved values that
were submitted: workflow, prompt, negative, seed, dimensions, and saved paths.

The registry is persisted to the session branch as a `comfyui-generations` custom entry (a full snapshot per mutation,
the same machinery the ephemeral overlay uses) and rebuilt on `session_start` / `session_tree`, so the gallery and the
reuse params survive `/reload`, a branch switch, and exit -> resume. Background jobs are de-duplicated by ComfyUI prompt
id, so a job recorded by the off-turn auto-download and then `collect`ed appears once.

Two `generate_image` params turn a recorded render into a starting point:

- `variationOf: "g3"` inherits g3's workflow, prompt, negative, seed, and dimensions as the baseline, then applies any
  param passed in the same call on top. Because the seed is reused, an unmodified `variationOf` reproduces the original;
  pass a new `seed` (or tweak the prompt / dims) to vary it. `prompt` is optional in this mode (it falls back to g3's).
- `refine: "g3"` feeds g3's saved image into an edit workflow as its input image. Set `workflow` to an edit workflow and
  `prompt` to the edit instruction; do not also pass `inputImages` (refine supplies it). The saved file must still exist
  on disk. Pass `variationOf` or `refine`, not both.

`/comfyui gallery` lists the recorded generations for the current session, one truncated line each.
`/comfyui gallery <id>` prints that generation's full, untruncated `prompt` and `negative` exactly as submitted - the
enhanced text when the prompt enhancer ran - so it is the way to read the whole enhanced prompt the line view clips to
60 chars. Unknown ids return a clear error pointing at the gallery.

## Image-generated event bus

Whenever a render lands on disk - foreground call, auto-downloaded background job, or a manual `collect` - the extension
emits an `ImageGeneratedEvent` (`{ savedPaths, workflow, prompt?, seed?, background }`) on a neutral,
globalThis-anchored bus ([`../../../lib/node/pi/comfyui/events.ts`](../../../lib/node/pi/comfyui/events.ts)). comfyui
only _emits_ - it has no knowledge of who, if anyone, listens; emitting to zero subscribers is a no-op. Another
extension subscribes with `onImageGenerated(listener)` (which returns an unsubscribe to call on teardown). Today
[`roleplay.ts`](./roleplay.md) consumes it to mirror the latest scene render into the avatar's `scene` banner while a
roleplay scene is active; comfyui stays decoupled from both roleplay and the avatar. A throwing listener is swallowed so
a broken consumer can never break generation.

### Tool: `image_jobs`

| Action    | Notes                                                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list`    | Show every background job and its status (`running` / `done` / `error` / `cancelled`).                                                                                               |
| `collect` | Poll the job (`id`); when its render is done, fetch the image(s) and return them inline.                                                                                             |
| `cancel`  | Best-effort cancel of a job (`id`): interrupts it if it is the render currently executing, else drops it from the pending queue. A render that already finished still lands on disk. |

`collect` is safe to call repeatedly: it reports `still running` until ComfyUI finishes, then returns the image(s) and
marks the job `done`. When `autoDownload` already saved the job off-turn, `collect` finds it `done` and re-serves the
files from disk inline instead of re-fetching. Collection honors the same `sendToModel` / vision rules as a foreground
generation, evaluated against the model active at collect time. The PNG is always written to `saveDir` regardless. If
the prompt is gone from both the server's `/history` and its `/queue` (e.g. ComfyUI was restarted mid-render), `collect`
marks the job `error` with a resubmit hint instead of looping on `still running` forever.

The registry lives only for the current pi session. Running jobs are surfaced two ways so the model does not forget
them: a `▦ img:N` statusline indicator (via `statusline.ts`) and a `## Pending image jobs` block injected each turn as
an ephemeral `<system-reminder id="comfyui-jobs">` spliced into the last user/toolResult turn via the `context` hook
(not the system prompt, so the prompt-prefix cache survives job churn; nothing is injected when no jobs are running).
Use `/comfyui jobs` to list them yourself. The same `context` hook also applies the ephemeral-render collapse overlay
(see [Ephemeral renders](#ephemeral-renders-ephemeral)) before the reminder, so both edits ride one rewrite of the
outgoing payload.

## Configuration

Config layers lowest to highest: the shipped `txt2img` example, then `~/.pi/agent/comfyui.json`, then
`<cwd>/.pi/comfyui.json`.

The extension **auto-disables** when neither user nor project `comfyui.json` contributes a `workflows` entry - the
shipped [`txt2img.api.json`](../comfyui/txt2img.api.json) is example scaffolding (it expects a
`v1-5-pruned-emaonly.safetensors` checkpoint most servers won't have), not a real default. Drop at least one workflow
into one of the config files to opt in; see [`../comfyui-example.json`](../comfyui-example.json) for a starting point.

| Key                     | Default                  | Meaning                                                                                                                                          |
| ----------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `baseUrl`               | `http://127.0.0.1:8188`  | ComfyUI server origin. Supports `${ENV}`. `PI_COMFYUI_URL` overrides it.                                                                         |
| `authHeader`            | (none)                   | `{ "name", "value" }` sent on every request; `value` supports `${ENV}`.                                                                          |
| `timeoutMs`             | `180000`                 | Hard cap per generation before it is aborted.                                                                                                    |
| `saveDir`               | `.pi/comfyui-out`        | Where PNGs are written (relative to cwd, or an absolute path).                                                                                   |
| `defaultWorkflow`       | `txt2img`                | Workflow used when the tool call omits `workflow`.                                                                                               |
| `sendToModel`           | `true`                   | Return the image in the tool result (fed to the model next turn). `false` saves to disk only.                                                    |
| `ephemeral`             | `false`                  | Render images inline this turn, then collapse the call + image out of context afterward. Per-call arg overrides.                                 |
| `background`            | `false`                  | Submit generations as background jobs by default (collect later via `image_jobs`). Per-call `background` arg overrides.                          |
| `autoDownload`          | `true`                   | Poll background jobs off-turn and fetch finished PNGs to `saveDir` automatically. `false` reverts to pull-only collect.                          |
| `pollIntervalMs`        | `3000`                   | How often the auto-download timer polls `/history` per running job (floored at `1000`). Only used when `autoDownload`.                           |
| `enhance`               | `false`                  | Run the prompt-enhancer subagent by default. Per-call `enhance` arg overrides; `PI_COMFYUI_DISABLE_ENHANCE` kills it.                            |
| `enhanceModel`          | (inherit)                | `provider/model-id` for the enhancer subagent. Absent = inherit the active session model.                                                        |
| `enhanceTimeoutMs`      | `30000`                  | Wall-clock cap (ms) per enhancer run. Raise it when an inherited slow model aborts with `timed out after …ms`.                                   |
| `enhanceContextChars`   | `0` (off)                | Max chars of recent conversation auto-fed to the enhancer as scene context. `0` = off. Costs extra input tokens.                                 |
| `enhanceGuidanceFile`   | (none)                   | Path to a global prompt-enhancer guidance doc, prepended before any per-workflow `guidanceFile`. `~` / abs / rel-cwd.                            |
| `autoRefine`            | `false`                  | Run the auto-refine vision-critic loop by default. Per-call `autoRefine` / per-workflow `refine` override; `PI_COMFYUI_DISABLE_REFINE` kills it. |
| `refineModel`           | (inherit)                | Vision-capable `provider/model-id` for the refine critic. Absent = inherit the session model when it has image input, else no-op.                |
| `refineTimeoutMs`       | `120000`                 | Wall-clock cap (ms) per refine-critic run.                                                                                                       |
| `maxRefineIterations`   | `2`                      | Max corrective renders after the initial (total renders <= 1 + N). Also stops on accept, a score plateau, or the cap.                            |
| `refineAcceptThreshold` | `7`                      | Score (0-10) at / above which the critic verdict is forced to accept, so the loop cannot burn the budget on nits.                                |
| `refineGuidanceFile`    | (none)                   | Path to a global refine-critic guidance doc, prepended before any per-workflow `refineGuidanceFile`. `~` / abs / rel-cwd.                        |
| `previewMaxDimension`   | (none)                   | Cap (px) on the longer side of the model-facing image copy; the saved file stays full-res. Absent / `0` = full-res.                              |
| `defaults`              | (none)                   | Generation-param defaults pre-filled when a call omits them; merge by field. See below.                                                          |
| `workflows`             | `{ txt2img: <shipped> }` | Named workflows; merge by name across layers.                                                                                                    |

Every scalar above resolves
`per-call arg > project config (<cwd>/.pi/comfyui.json) > user config (~/.pi/agent/comfyui.json) > built-in default`. So
a project that drops `sendToModel: false` into its `<cwd>/.pi/comfyui.json` renders save-only for every generation under
that directory, while a global `~/.pi/agent/comfyui.json` setting it `true` still applies everywhere else - and an
explicit per-call `sendToModel` arg wins over both.

```jsonc
// <cwd>/.pi/comfyui.json - this project saves images to disk without feeding them back to the model
{
  "sendToModel": false,
}
```

Both `comfyui.json` config files **and** the workflow graph files under [`../comfyui/`](../comfyui/) are read as JSONC:
`//` line comments, `/* */` block comments, and trailing commas are stripped before parsing, so the example above (and
any annotation you add to a graph) parses cleanly. Comments are removed client-side; the ComfyUI server never sees them.

With `sendToModel: false` (or the per-call `sendToModel` arg set false), the PNG is still written to `saveDir` but the
tool result is a text-only summary with the saved path - the image is neither rendered inline nor sent to the model, so
no image tokens enter context. Use it when the user just wants the picture, not for the model to analyze. The per-call
arg overrides the config default.

Regardless of `sendToModel`, the image is held back automatically when the active model has no vision input - the
extension inspects `ctx.model.input` and, if it is a list lacking `"image"`, falls back to save-only and notes
`(active model has no image input; not sent to model)` in the summary. When the model's capabilities are unknown (no
`input` list), the `sendToModel` preference is honored as-is.

### Ephemeral renders (`ephemeral`)

`sendToModel` is all-or-nothing across two concerns: it gates both whether the image renders inline **and** whether it
reaches the model. `ephemeral` splits them for the visual-novel / roleplay case where the picture is for the **user**,
not the model:

| Mode                 | Inline in terminal | In model context |
| -------------------- | ------------------ | ---------------- |
| `sendToModel: true`  | yes                | yes (every turn) |
| `sendToModel: false` | no                 | no               |
| `ephemeral: true`    | yes (this turn)    | no               |

When `ephemeral` is set, the rendered image still rides in the tool result so the TUI shows it for the turn it is
generated, but the extension records a **collapse directive** keyed by the call's `toolCallId`. The `context` hook then
blanks that `generate_image` call's arguments and replaces its result (image included) with a `[TOOL CALLED]` marker on
every outgoing provider payload - this turn's continuation included - so the model never reads the scene and it costs no
persistent context. Because the image never reaches the model, the `sendToModel` / vision gate is moot for an ephemeral
render; the block is always attached for the terminal.

The collapse is non-destructive (the real session `.jsonl` keeps the full call + image) and reuses the same
`context-edit` overlay machinery as the `tool-collapse` extension. It is persisted as a `comfyui-ephemeral-state` custom
entry and rebuilt from the branch on `session_start` / `session_tree`, so a `/reload`, a branch switch, or an exit ->
resume all keep prior ephemeral renders collapsed. `ephemeral` applies to foreground renders only - a `background: true`
job returns no image to collapse, so the flag is ignored when backgrounding.

```jsonc
// <cwd>/.pi/comfyui.json - a roleplay project whose scene renders are for the reader, not the model
{
  "ephemeral": true,
}
```

### Workflows and the input map

ComfyUI API-format workflows are keyed by opaque node ids, and the tunable values live inside specific nodes. Each
workflow entry points at its JSON file and maps tunable names to a node id + input key:

```jsonc
{
  "workflows": {
    "txt2img": {
      "file": "~/.pi/agent/comfyui/txt2img.api.json",
      "inputs": {
        "prompt": { "node": "6", "key": "text" },
        "negative": { "node": "7", "key": "text" },
        "seed": { "node": "3", "key": "seed" },
        "steps": { "node": "3", "key": "steps" },
        "cfg": { "node": "3", "key": "cfg" },
        "width": { "node": "5", "key": "width" },
        "height": { "node": "5", "key": "height" },
        "batch": { "node": "5", "key": "batch_size" },
      },
    },
    "img2img": {
      "file": "~/.pi/agent/comfyui/img2img.api.json",
      "inputs": {
        "prompt": { "node": "6", "key": "text" },
        "denoise": { "node": "3", "key": "denoise" },
        "seed": { "node": "3", "key": "seed" },
      },
      "images": [{ "node": "10", "key": "image" }],
    },
    "qwen-image-edit": {
      "file": "~/.pi/agent/comfyui/qwen-image-edit.api.json",
      "inputs": {
        "prompt": { "node": "6", "key": "prompt" },
        "seed": { "node": "3", "key": "seed" },
        "steps": { "node": "3", "key": "steps" },
      },
      "images": [{ "node": "41", "key": "image" }],
    },
    "flux2-t2i": {
      "file": "~/.pi/agent/comfyui/flux2-t2i.api.json",
      "inputs": {
        "prompt": { "node": "4", "key": "text" },
        "negative": { "node": "5", "key": "text" },
        "seed": { "node": "12", "key": "noise_seed" },
        "steps": { "node": "8", "key": "steps" },
        "cfg": { "node": "10", "key": "cfg" },
        "width": { "node": "6", "key": "value" },
        "height": { "node": "7", "key": "value" },
        "batch": { "node": "9", "key": "batch_size" },
      },
    },
    "flux2-edit": {
      "file": "~/.pi/agent/comfyui/flux2-edit.api.json",
      "inputs": {
        "prompt": { "node": "4", "key": "text" },
        "seed": { "node": "12", "key": "noise_seed" },
        "steps": { "node": "8", "key": "steps" },
        "cfg": { "node": "10", "key": "cfg" },
      },
      "images": [{ "node": "20", "key": "image" }],
    },
    "flux2-edit-multi": {
      "file": "~/.pi/agent/comfyui/flux2-edit-multi.api.json",
      "inputs": {
        "prompt": { "node": "4", "key": "text" },
        "seed": { "node": "12", "key": "noise_seed" },
        "steps": { "node": "8", "key": "steps" },
        "cfg": { "node": "10", "key": "cfg" },
      },
      "images": [
        { "node": "20", "key": "image" },
        { "node": "30", "key": "image" },
      ],
    },
  },
}
```

Export a workflow from ComfyUI with "Save (API Format)", drop it somewhere readable, and point `file` at it. The `batch`
map key receives the tool's `count` arg. To get the node ids, open the API-format JSON (its top-level keys are the node
ids) or enable node-id badges in the ComfyUI canvas.

#### Workflow discoverability (optional)

A workflow entry may carry optional metadata, surfaced to the model in the `generate_image` tool description so it picks
the right workflow and sends the right prompt shape:

- `description` - one line on what the workflow is for (e.g. `"anime / illustration"`).
- `tags` - short string tags (e.g. `["anime", "sdxl"]`).
- `promptProtocol` - the prompting dialect the model should send for `prompt` / `negative` (e.g.
  `"Danbooru tags, comma-separated"` vs `"natural language"`). The model sends prompts in each workflow's native
  protocol; this names the dialect rather than forcing one shape. A non-natural-language protocol also drives the
  `recommends enhance` hint in the matrix (when the enhancer is installed).
- `guidanceFile` - path to a per-workflow prompt-enhancer guidance doc, concatenated after the global
  `enhanceGuidanceFile` when `enhance` runs (see [Prompt enhancement](#prompt-enhancement-enhance)). Resolves like
  `file` (`~` / absolute / relative-to-cwd). Optional; the enhancer degrades to `description` / `tags` when absent.
- `enhance` - per-workflow override of the global `enhance` flag. `true` enhances by default for this workflow even when
  the global default is off (and vice versa). Resolution is
  `per-call enhance arg ?? workflow.enhance ?? config.enhance`. Optional.
- `refine` - per-workflow override of the global `autoRefine` flag. Resolution is
  `per-call autoRefine arg ?? workflow.refine ?? config.autoRefine`. Optional.
- `refineGuidanceFile` - path to a per-workflow refine-critic guidance doc, concatenated after the global
  `refineGuidanceFile` when `autoRefine` runs. Resolves like `file`. Optional.
- `refineWith` - map from a repair channel (`img2img` / `inpaint` / `detailer` / `ground`) to the name of another
  configured workflow that runs it. A channel is offered only when its companion resolves to a configured workflow; the
  t2i channels (`reroll` / `revise_prompt`) always work. See
  [refineWith companion channels](#refinewith-companion-channels) for the per-channel companion patterns. Optional.
- `refineCriteria` - default acceptance criteria handed to the refine critic for this workflow (e.g.
  `"full body, facing left"`). A per-call `refineCriteria` arg overrides it. Optional.

```jsonc
{
  "workflows": {
    "anima": {
      "file": "~/.pi/agent/comfyui/anima.api.json",
      "inputs": {
        /* ... */
      },
      "description": "anime / illustration",
      "tags": ["anime", "sdxl"],
      "promptProtocol": "Danbooru tags, comma-separated",
      "guidanceFile": "~/.pi/agent/comfyui/anima-guidance.md",
    },
  },
}
```

These render as a compact capability matrix in the `generate_image` tool description. The params shared by every
configured workflow are stated once in a leading `All workflows accept: …` line, and each workflow's own line then
carries only its extras (`+denoise, width, height`), its reference-image slot count or named roles, the prompt protocol,
and a `recommends enhance` hint where relevant - so the model stops guessing workflow names and passing params a
workflow does not support without the matrix repeating the common set on every line. All fields are optional; a workflow
without them just shows its name (and any extras beyond the common set).

#### refineWith companion channels

`refineWith` declares, per source workflow, which other configured workflow runs each
[`autoRefine`](#prompt-refinement-autorefine) repair channel. The refiner picks one channel per round, validates it
against this map, and downgrades when the named companion is not configured. Every companion shares the same back-half
(model loaders + masked / encoded latent -> sampler -> VAE decode); only the front-end (how the repair region is
produced) differs, so per model it is ~2-3 authored graphs.

```jsonc
{
  "workflows": {
    "anima": {
      "file": "~/.pi/agent/comfyui/anima.api.json",
      "inputs": {
        /* ... t2i ... */
      },
      "refine": true,
      "refineWith": {
        "img2img": "anima-img2img",
        "inpaint": "anima-inpaint",
        "detailer": "anima-detailer",
        "ground": "anima-ground",
      },
    },
  },
}
```

The image being repaired is uploaded into each companion's `init` role; the action's params (`denoise`, and the
localizer inputs below) are layered onto the source prompt / negative, which carry over so the companion repaints
in-style. The four channels:

- **`img2img`** - a whole-image low-denoise polish, the no-localization fallback. The companion is a plain img2img graph
  with an `init` role and a mapped `denoise`. No mask, no detector; the critic only sets the denoise strength.
- **`inpaint`** - a coarse-region masked repaint. The critic names a region (`center`, `top-left`, `bottom`, …, or none
  for the whole image), the extension turns it into a normalized bbox and synthesizes the mask through the existing
  [bbox-mask path](#image-inputs-positional-or-named-roles), and the companion reads it via a `mask` role
  (`kind: "mask"`). The critic never emits pixel coordinates - it names _what_ and _whether it is local_; the bbox
  geometry is the extension's job. The shipped [`anima-inpaint.api.json`](../comfyui/anima-inpaint.api.json) adapts the
  Cosmos Predict 2 `anima` checkpoint to inpaint in-place: `LoadImage` (init) -> `VAEEncodeForInpaint` (`grow_mask_by`
  softens the masked edge) -> `SetLatentNoiseMask` -> the standard `KSampler` at `denoise < 1` -> `VAEDecode`. Cosmos is
  a world model, not inpaint-tuned, so the companion runs more steps (24) and a higher denoise (0.6) than the base t2i
  pass to fill cleanly without seams; tune `grow_mask_by` / `denoise` / `steps` per checkpoint.
- **`detailer`** - automatic hand / face / eyes repair with no named region. The companion is an Ultralytics-style
  graph: an `UltralyticsDetectorProvider` + `BboxDetector` (or `SAMDetector`) finds the region, and `DetailerForEach`
  crops it, re-renders at higher resolution, and pastes it back. Parameterize the detector class as a `detect` input
  (`hand` / `face` / `eyes` / `person`) so one graph covers every detector target; the critic sets `action.detect`.
- **`ground`** - a named target phrase localized in-graph. The companion runs an open-vocabulary grounder (Florence-2 or
  GroundingDINO) over the critic's `target` phrase ("the left pauldron") to produce a mask, then runs the same masked
  inpaint back-half as the `inpaint` channel. Map the phrase to a `target` input so the critic's `action.target` drives
  it; the localization stays inside the graph (the critic supplies the phrase, never a box).

A `detailer` / `ground` companion that consumes `detect` / `target` MUST map them in its `inputs` (an unmapped-but-
supplied value is a graph-mapping error surfaced before submit). The 24 GB-VRAM + 64 GB-RAM target server co-loads the
detector / grounder / SAM models alongside the diffuser and keeps them warm between rounds, so the multi-model channels
cost a few PCIe seconds per swap rather than a reload - run the heavier ones under `background`. `/comfyui workflows`
warns (`⚠`) when a `refineWith` target is not a configured workflow, so a typo'd companion name is caught before a
generation.

#### The tool schema only advertises params your workflows can use

The `generate_image` parameter schema is built at registration time from the aggregate capabilities of the configured
workflows, so the model-facing tool definition never carries params nothing can consume. A pure text-to-image setup
omits `inputImages` / `images` (and the bbox-mask `feather` / `invert` sub-fields), and `width` / `height` / `aspect`,
`denoise`, `steps`, `cfg`, `seed`, `count`, and `negative` each appear only when some workflow maps them; `refine`
appears only when some workflow accepts an image input; `enhance` / `context` only when the prompt enhancer is installed
(see [Prompt enhancement](#prompt-enhancement-enhance)). Every param is optional and the executor reads
`params.X ?? config.X`, so omitting a param simply keeps it out of the schema - it never changes how a present param
behaves.

#### Image inputs: positional or named roles

Image inputs for edit / img2img / inpaint workflows are declared in a top-level `images` field on the workflow entry (a
sibling of `inputs`, not a key inside it), in one of two mutually exclusive shapes:

- **Positional** - an array of `{ "node", "key" }` pairs naming `LoadImage`-style slots. The ordered `inputImages` tool
  arg fills them in order (`inputImages[0]` into `images[0]`, …). Supplying more images than slots is an error; fewer
  fills the leading slots and leaves the trailing slots at the image baked into the graph file.
- **Named roles** - an object keyed by role (`init`, `mask`, `control`, …) whose values are `{ "node", "key" }` pairs
  with two optional extras: `"kind": "mask"` marks a slot a bbox mask may target, and `"invert": true` flips that mask's
  polarity. The `images` tool arg supplies each slot by role: `images: { "init": "~/in.png", "mask": "~/m.png" }`.

A call uses `inputImages` xor `images`, matching the workflow's declared shape; passing the wrong one (or an unknown
role, or any image arg to a text-to-image workflow) is a clear error rather than a silent no-op. A `refine` id feeds the
prior render into the `init` role on a role-based workflow (and `inputImages[0]` on a positional one).

A `mask` role accepts either a path to a mask image or a bbox synth spec
`{ "bbox": [[x, y, w, h], …], "feather"?, "invert"? }` with **normalized** (`0`-`1`, top-left-origin) rectangles,
unioned for multi-region edits; out-of-range or zero-area rectangles error. The extension rasterizes the mask (white =
the region to change, black = keep) sized to the `init` image's dimensions, else the resolved `width` / `height`, else
errors; optional `feather` (px) softens the edge. The mask is uploaded as its own slot, so the graph's mask node should
be a `LoadImageMask`-style input.

`file` resolves like every other config path: a leading `~` expands to your home dir, an absolute path is used as-is,
and a relative path (`./local/wf.api.json`, `wf/foo.api.json`) resolves against the session cwd. Relative resolution is
against the cwd regardless of which config layer declared the workflow, so a project-local `<cwd>/.pi/comfyui.json` can
point at a graph checked into the project with `"file": "./comfyui/my.api.json"`.

The shipped default [`../comfyui/txt2img.api.json`](../comfyui/txt2img.api.json) is the classic SD1.5 graph; it expects
a `v1-5-pruned-emaonly.safetensors` checkpoint to be installed on the server. Repoint `defaultWorkflow` / `workflows` at
your own graph + checkpoint as needed.

Two image-to-image examples ship alongside it: [`../comfyui/img2img.api.json`](../comfyui/img2img.api.json) is the
classic SD1.5 VAE-encode graph (its single `images` slot maps the uploaded image into the `LoadImage` node), and
[`../comfyui/qwen-image-edit.api.json`](../comfyui/qwen-image-edit.api.json) is a modern instruction-edit graph
(Qwen-Image-Edit 2511 GGUF + a 4-step Lightning LoRA). Its `prompt` is an **edit instruction** encoded by
`TextEncodeQwenImageEditPlus`, so the map key is `prompt` (not the `text` that `CLIPTextEncode` uses). The Plus encoder
bakes the reference image into the conditioning, `FluxKontextImageScale` (node 60) snaps the source to a supported edit
resolution, and `FluxKontextMultiReferenceLatentMethod` (node 43) anchors the edit - which lets the KSampler run at
`denoise 1` (the source latent only sets the output resolution). Lowering `denoise` is the wrong knob, so its map
exposes none; `CFGNorm` (node 75) stabilises the cfg-1 Lightning setup.

Two **FLUX.2 [klein] 9B** graphs round out the set, both loading GGUF weights via `UnetLoaderGGUF` and the Qwen3-8B text
encoder via `CLIPLoaderGGUF` (`type: flux2`) alongside the `flux2-vae`.
[`../comfyui/flux2-t2i.api.json`](../comfyui/flux2-t2i.api.json) is text-to-image: it samples with
`SamplerCustomAdvanced` (a `RandomNoise` seed, `Flux2Scheduler` sigmas, and a `KSamplerSelect` euler), and because
FLUX.2 is guided through a `CFGGuider` the example maps `cfg` there rather than at a KSampler. `width` / `height` map to
two `PrimitiveInt` nodes (6 / 7) that feed both `Flux2Scheduler` and `EmptyFlux2LatentImage`, so a single injection
keeps the resolution-dependent sigma shift and the latent size in lockstep.
[`../comfyui/flux2-edit.api.json`](../comfyui/flux2-edit.api.json) is the instruction-edit variant: the uploaded image
is scaled to ~1 MP, VAE-encoded, and anchored into both the positive and negative conditioning through `ReferenceLatent`
(nodes 24 / 25), with `GetImageSize` driving the output dimensions. As with Qwen above it runs at `denoise 1` (the empty
latent only sets resolution), so its map exposes neither `denoise` nor `width` / `height` - the edit follows the source
size.

[`../comfyui/flux2-edit-multi.api.json`](../comfyui/flux2-edit-multi.api.json) extends that edit graph to **two**
ordered reference images. Each reference is scaled to ~1 MP and VAE-encoded independently (nodes 20/21/23 for ref1,
30/31/33 for ref2), then both reference latents are **stacked** through `ReferenceLatent` onto each conditioning chain -
ref1 then ref2 on the positive chain (nodes 24 -> 26) and the same on the negative chain (nodes 25 -> 27) - so
`CFGGuider` sees a conditioning carrying both references. Output size still follows ref1 via `GetImageSize` (node 22).
Its `images` array has two slots (`[{node: 20}, {node: 30}]`); call it with `inputImages: ["ref1.png", "ref2.png"]`, or
pass a single image to combine ref1 with the graph's baked ref2.

Each ships in two flavours: the base graph (`flux2-t2i` / `flux2-edit`, undistilled, ~20 steps at cfg 5) and a distilled
`*-fast` graph (`flux2-t2i-fast` / `flux2-edit-fast`, 4 steps at cfg 1) that swaps in the distilled diffusion GGUF. The
distilled variants are the practical interactive default; the base edit in particular is heavy - the reference image
inflates the token sequence the diffusion model processes every step - so a slow or VRAM-constrained server may need a
larger `timeoutMs` or a `background: true` submission. A smaller GGUF text-encoder quant frees VRAM for the diffusion
model and noticeably cuts the per-step time. All five route the diffusion model through a `ModelPatchTorchSettings`
(node 16, `enable_fp16_accumulation`) before the `CFGGuider`, which speeds up matmuls on Ampere/Ada GPUs (requires
PyTorch >= 2.7; it is a no-op otherwise). They also route the diffusion model through an empty
`Power Lora Loader (rgthree)` (node 17) - a passthrough until you toggle LoRAs into its list, so model-only FLUX.2 LoRAs
can be stacked without re-wiring the graph.

### torch.compile on the FLUX.2 graphs

All five FLUX.2 graphs additionally route the diffusion model through a `TorchCompileModelAdvanced` (node 18, from
[ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes)) between `ModelPatchTorchSettings` (node 16) and the
`CFGGuider` (node 10). On a warm compile this is a large, **lossless** speedup (`torch.compile` is numerically
equivalent): text-to-image at 1024x1024 / 4 steps drops from ~32s to ~10s (about 3x), and the edit graphs from ~25s to
~14-20s. It carries real prerequisites, so the node is the first thing to remove (repoint node 10's `model` back to
`["16", 0]`) if you run these graphs on a different server:

- **ComfyUI-KJNodes must be installed** - `TorchCompileModelAdvanced` is a KJNodes node; without it the graph fails to
  load.
- **The server must use a compile-traceable attention backend.** Launch ComfyUI **without** `--use-flash-attention` so
  it falls back to native PyTorch SDPA. The custom flash-attention op ships an incorrect meta (fake) kernel, so
  `torch.compile` raises a stride error at the sampler the moment it traces attention; SDPA traces cleanly (and here
  benchmarked slightly faster than flash-attention even uncompiled).
- **`disable_dynamic_vram: true` is required when the server runs a dynamic weight offloader** such as
  [`comfy-aimdo`](https://github.com/Comfy-Org/comfy-aimdo), which virtualizes VRAM by paging weights between GPU and
  host RAM. The pager rewrites weight pointers every step, which busts `torch.compile`'s guards and forces a recompile
  on every render (`recompile_limit` churn). The flag clones the model down to a plain `ModelPatcher` (no paging) before
  compiling - see the maintainer note in [comfy-aimdo#13](https://github.com/Comfy-Org/comfy-aimdo/issues/13). The
  compiled model must then fit in physical VRAM: the GGUF Q6_K klein peaks ~9.5 GB (incl. the Qwen3 encoder +
  activations), comfortable on a 16 GB card. Pair it with a low `--reserve-vram` (e.g. `0.25`) so the loader keeps the
  model resident instead of streaming it.
- `compile_transformer_blocks_only: true` compiles just the diffusion transformer blocks (faster, more robust compile);
  `dynamic: "false"` and `dynamo_cache_size_limit: 64` are the validated defaults.

**Cold vs warm, and restarts.** The first render at each distinct resolution (and the first after any server restart)
pays a one-time compile of ~30-200s (heavier for the edit graphs, heaviest for the two-reference `flux2-edit-multi`);
every later render at that resolution is warm. The compiled artifacts do **not** reliably survive a process restart:
torch's on-disk `FxGraphCache` key is unstable across processes for this lazy per-block compile, and even the portable
Mega-Cache (`torch.compiler.save_cache_artifacts` / `load_cache_artifacts`) only partially reattaches - so budget one
cold compile per resolution after each pod restart. Pointing `TORCHINDUCTOR_CACHE_DIR` at a persistent volume is still
worthwhile (it keeps the Triton kernel cache warm and survives restarts) but does not by itself produce a warm first
render.

**fp8 instead of GGUF (optional, needs VRAM).** Swapping `UnetLoaderGGUF` (node 1) for a `UNETLoader` pointed at an fp8
`safetensors` klein (`weight_dtype: default`) compiles even cleaner: GGUF's `GGMLTensor` wrapper carries a custom
`tensor_shape` attribute that triggers extra recompiles on the edit graphs' variable-length reference sequence, which
fp8's plain tensors avoid (edit warms to ~14s vs ~20s on GGUF). The cost is VRAM - the fp8 model is ~8.8 GB on disk and
the edit working set peaks ~12 GB, so it is tight on a 16 GB card (it fits resident with `--reserve-vram 0.25` but
leaves little margin for larger reference images or batches). The shipped graphs use GGUF for that headroom; switch to
fp8 if you have the VRAM to spare.

`anima` is deliberately left uncompiled: it is a small, sampling-dominated model where `torch.compile` measured
break-even, so the compile node would only add a cold-start cost for no throughput gain.

### Generation defaults

`width`, `height`, `steps`, `cfg`, `denoise`, `count`, and `negative` can only be baked per-workflow inside the graph
JSON otherwise. The optional `defaults` block lets a user pin them per-project (or globally) without editing every
workflow graph - e.g. "this project renders 1024x1024 at 30 steps":

```jsonc
// <cwd>/.pi/comfyui.json
{
  "defaults": { "width": 1024, "height": 1024, "steps": 30, "cfg": 5, "count": 1 },
  "workflows": {
    /* ... */
  },
}
```

Resolution per param is `per-call arg > config defaults > workflow-baked graph value`. A default just pre-fills the
param before injection, so it is still only applied if the active workflow's input map names a node for it - a workflow
that doesn't map `steps` ignores a `defaults.steps`. Numeric defaults must be positive; `negative` may be empty (an
explicit empty negative prompt). The block merges by field across layers, so a project config can override a single
default (e.g. `steps`) on top of a global one without redeclaring the rest.

## Environment variables

| Variable                     | Effect                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `PI_COMFYUI_DISABLED`        | Skip the extension entirely.                                                      |
| `PI_COMFYUI_URL`             | Override the configured `baseUrl`.                                                |
| `PI_COMFYUI_TOKEN`           | Convention for a token referenced by `authHeader.value` as `${PI_COMFYUI_TOKEN}`. |
| `PI_COMFYUI_DISABLE_ENHANCE` | Hard-disable the prompt enhancer regardless of config / per-call `enhance`.       |
| `PI_COMFYUI_ENHANCE_DEBUG`   | Notify on each successful enhance (`enhanced → …`); failures notify regardless.   |
| `PI_COMFYUI_DISABLE_REFINE`  | Hard-disable the auto-refine loop regardless of config / per-call `autoRefine`.   |
| `PI_COMFYUI_REFINE_DEBUG`    | Notify on each critic decision / refine round; failures notify regardless.        |

Auth headers are sent on every HTTP request. ComfyUI's websocket does not carry custom headers, so on an authenticated
server the progress stream may not connect; polling still drives completion regardless.

## Command

`/comfyui` reports status: resolved base URL and reachability (a `GET /system_stats` ping), whether an auth header is
configured, the default workflow, the configured workflow names, and `saveDir`. `/comfyui workflows` loads each
configured workflow file and validates that every mapped node id exists in the graph, so a bad input map is caught
without a generation round-trip. `/comfyui jobs` lists the current session's background generations and their status.
`/comfyui gallery` lists the recorded generation registry (every render that landed on disk, with its `g<n>` id) for
reuse via `variationOf` / `refine`. `/comfyui refine <gX>` re-runs the same auto-refine critic loop over an existing
gallery render: it writes a NEW gallery entry with lineage back to the source (`refined from: gX`), saves every render
to disk, and notifies you with the journey - being a slash command it returns nothing to the model's context.
`/comfyui models` queries the server's `/object_info` and lists the installed model files it advertises (checkpoints,
VAEs, LoRAs, CLIP / UNet weights, ControlNets, upscalers) so you can fill in `ckpt_name` / `lora_name` values when
configuring a workflow. It is a read-only operator aid and is never exposed to the model.

## Hot reload

Edit [`comfyui.ts`](./comfyui.ts) or any companion under [`../../../lib/node/pi/comfyui/`](../../../lib/node/pi/comfyui)
or [`../../../lib/node/pi/ext/comfyui/`](../../../lib/node/pi/ext/comfyui) and run `/reload` in an interactive pi
session. The tool registration, workflow list, and tool description are computed at load time, so a `/reload` re-runs
registration and picks up changes to `comfyui.json` / the workflow graphs. The `session_shutdown` handler clears the
`comfyui` statusline badge (`▦ img:N`) and drops the in-memory background-job registry on reload, so a stale job count
never bleeds into the next session. The ephemeral-render collapse overlay is **not** dropped across a reload: it is
persisted as a `comfyui-ephemeral-state` custom entry and rebuilt from the branch on `session_start` / `session_tree`,
so prior ephemeral renders stay collapsed out of context after a `/reload`, a branch switch, or an exit -> resume. The
generation registry (the `g<n>` gallery) is likewise persisted as a `comfyui-generations` custom entry and rebuilt from
the branch, so prior renders stay addressable by `variationOf` / `refine` across a `/reload`. The jobs themselves run
server-side and are not re-attached after reload - ComfyUI keeps each prompt under its id, so re-collect via the
server's own history if a generation was in flight.

## Related docs

- [README.md](./README.md) - extension index.
- [`../../../lib/node/pi/comfyui/`](../../../lib/node/pi/comfyui) - the pure helpers this shell composes.
- [`../../../lib/node/pi/ext/comfyui/`](../../../lib/node/pi/ext/comfyui) - the runtime-coupled helpers (the
  `ComfyuiRuntime`, the two tool bodies, params / render / images / enhancer).
- [ComfyUI OpenAPI spec](https://github.com/Comfy-Org/ComfyUI/blob/main/openapi.yaml) - endpoint reference.
