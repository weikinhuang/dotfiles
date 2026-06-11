# comfyui

A local/remote [ComfyUI](https://github.com/comfyanonymous/ComfyUI) image-generation tool for pi. Registers a
`generate_image` tool the model calls to render an image, an `image_jobs` tool for background generations, and a
`/comfyui` status command. The result is returned inline as a multimodal tool result, so it renders in the terminal and
is visible to vision-capable models.

This is a custom tool, not a replacement for pi's built-in (provider-routed) image generation - pi exposes no
extension-pluggable image-provider hook, so a tool is the integration point, the same shape pi's own
`antigravity-image-gen.ts` example uses.

The pi-coupled glue (tool + command registration, the HTTP / websocket calls, result formatting) lives in
[`comfyui.ts`](./comfyui.ts). All pure logic - config layering + `${ENV}` interpolation, workflow parameter injection,
URL building, history / websocket parsing - lives under [`../../../lib/node/pi/comfyui/`](../../../lib/node/pi/comfyui)
and is unit-tested by [`../../../tests/lib/node/pi/comfyui/`](../../../tests/lib/node/pi/comfyui).

## How a generation runs

1. Resolve config and the named workflow (`workflow` arg, else `defaultWorkflow`).
2. Load and validate the API-format workflow JSON for that name.
3. For img2img, upload `inputImage` via `POST /upload/image` and reference the stored name in the workflow's mapped
   image node.
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

| Parameter     | Type    | Notes                                                                                             |
| ------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `prompt`      | string  | Required. Positive prompt.                                                                        |
| `negative`    | string  | Negative prompt.                                                                                  |
| `workflow`    | string  | Named workflow; defaults to `defaultWorkflow`.                                                    |
| `width`       | number  | Output width in pixels.                                                                           |
| `height`      | number  | Output height in pixels.                                                                          |
| `steps`       | number  | Sampler steps.                                                                                    |
| `cfg`         | number  | CFG / guidance scale.                                                                             |
| `seed`        | number  | Omit for a fresh random seed; pass a prior seed to reproduce.                                     |
| `denoise`     | number  | Denoise strength (img2img), `0`-`1`.                                                              |
| `inputImage`  | string  | Path to an input image (img2img workflows only).                                                  |
| `count`       | number  | Batch size.                                                                                       |
| `sendToModel` | boolean | Override the `sendToModel` config default for this call.                                          |
| `background`  | boolean | Submit and return now; collect later via `image_jobs`. Overrides the `background` config default. |

Each parameter is injected only if the active workflow's input map names a node for it. Passing an arg the workflow does
not map (or pointing `inputImage` at a workflow with no `image` mapping) returns a clear error rather than a silent
no-op.

## Background generation

A slow render (many steps, large dimensions, a big batch) can be fired off without blocking the turn by calling
`generate_image` with `background: true`. The tool submits the workflow, records a lightweight job, and returns the job
id immediately. ComfyUI keeps executing it server-side, so nothing is lost when the turn ends.

This works because ComfyUI queues every `POST /prompt` and persists the result under its `prompt_id`. A background job
is therefore just metadata - the registry holds no process or buffer - and the actual PNGs are fetched on collection.

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
them: a `▦ img:N` statusline indicator (via `statusline.ts`) and a `## Pending image jobs` block injected into the
system prompt each turn. Use `/comfyui jobs` to list them yourself.

## Configuration

Config layers lowest to highest: the shipped `txt2img` example, then `~/.pi/agent/comfyui.json`, then
`<cwd>/.pi/comfyui.json`.

The extension **auto-disables** when neither user nor project `comfyui.json` contributes a `workflows` entry - the
shipped [`txt2img.api.json`](../comfyui/txt2img.api.json) is example scaffolding (it expects a
`v1-5-pruned-emaonly.safetensors` checkpoint most servers won't have), not a real default. Drop at least one workflow
into one of the config files to opt in; see [`../comfyui-example.json`](../comfyui-example.json) for a starting point.

| Key               | Default                  | Meaning                                                                                                                 |
| ----------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`         | `http://127.0.0.1:8188`  | ComfyUI server origin. Supports `${ENV}`. `PI_COMFYUI_URL` overrides it.                                                |
| `authHeader`      | (none)                   | `{ "name", "value" }` sent on every request; `value` supports `${ENV}`.                                                 |
| `timeoutMs`       | `180000`                 | Hard cap per generation before it is aborted.                                                                           |
| `saveDir`         | `.pi/comfyui-out`        | Where PNGs are written (relative to cwd, or an absolute path).                                                          |
| `defaultWorkflow` | `txt2img`                | Workflow used when the tool call omits `workflow`.                                                                      |
| `sendToModel`     | `true`                   | Return the image in the tool result (fed to the model next turn). `false` saves to disk only.                           |
| `background`      | `false`                  | Submit generations as background jobs by default (collect later via `image_jobs`). Per-call `background` arg overrides. |
| `autoDownload`    | `true`                   | Poll background jobs off-turn and fetch finished PNGs to `saveDir` automatically. `false` reverts to pull-only collect. |
| `pollIntervalMs`  | `3000`                   | How often the auto-download timer polls `/history` per running job (floored at `1000`). Only used when `autoDownload`.  |
| `defaults`        | (none)                   | Generation-param defaults pre-filled when a call omits them; merge by field. See below.                                 |
| `workflows`       | `{ txt2img: <shipped> }` | Named workflows; merge by name across layers.                                                                           |

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

With `sendToModel: false` (or the per-call `sendToModel` arg set false), the PNG is still written to `saveDir` but the
tool result is a text-only summary with the saved path - the image is neither rendered inline nor sent to the model, so
no image tokens enter context. Use it when the user just wants the picture, not for the model to analyze. The per-call
arg overrides the config default.

Regardless of `sendToModel`, the image is held back automatically when the active model has no vision input - the
extension inspects `ctx.model.input` and, if it is a list lacking `"image"`, falls back to save-only and notes
`(active model has no image input; not sent to model)` in the summary. When the model's capabilities are unknown (no
`input` list), the `sendToModel` preference is honored as-is.

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
        "image": { "node": "10", "key": "image" },
        "denoise": { "node": "3", "key": "denoise" },
        "seed": { "node": "3", "key": "seed" },
      },
    },
    "qwen-image-edit": {
      "file": "~/.pi/agent/comfyui/qwen-image-edit.api.json",
      "inputs": {
        "prompt": { "node": "6", "key": "prompt" },
        "image": { "node": "41", "key": "image" },
        "seed": { "node": "3", "key": "seed" },
        "steps": { "node": "3", "key": "steps" },
      },
    },
    "flux-kontext": {
      "file": "~/.pi/agent/comfyui/flux-kontext.api.json",
      "inputs": {
        "prompt": { "node": "6", "key": "text" },
        "image": { "node": "41", "key": "image" },
        "cfg": { "node": "35", "key": "guidance" },
        "seed": { "node": "3", "key": "seed" },
        "steps": { "node": "3", "key": "steps" },
      },
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
        "image": { "node": "20", "key": "image" },
        "seed": { "node": "12", "key": "noise_seed" },
        "steps": { "node": "8", "key": "steps" },
        "cfg": { "node": "10", "key": "cfg" },
      },
    },
  },
}
```

Export a workflow from ComfyUI with "Save (API Format)", drop it somewhere readable, and point `file` at it. The `batch`
map key receives the tool's `count` arg; the `image` map key receives the uploaded `inputImage` name. To get the node
ids, open the API-format JSON (its top-level keys are the node ids) or enable node-id badges in the ComfyUI canvas.

`file` resolves like every other config path: a leading `~` expands to your home dir, an absolute path is used as-is,
and a relative path (`./local/wf.api.json`, `wf/foo.api.json`) resolves against the session cwd. Relative resolution is
against the cwd regardless of which config layer declared the workflow, so a project-local `<cwd>/.pi/comfyui.json` can
point at a graph checked into the project with `"file": "./comfyui/my.api.json"`.

The shipped default [`../comfyui/txt2img.api.json`](../comfyui/txt2img.api.json) is the classic SD1.5 graph; it expects
a `v1-5-pruned-emaonly.safetensors` checkpoint to be installed on the server. Repoint `defaultWorkflow` / `workflows` at
your own graph + checkpoint as needed.

Three image-to-image examples ship alongside it: [`../comfyui/img2img.api.json`](../comfyui/img2img.api.json) is the
classic SD1.5 VAE-encode graph (note the `image` key maps the uploaded `inputImage` into the `LoadImage` node), and
[`../comfyui/qwen-image-edit.api.json`](../comfyui/qwen-image-edit.api.json) is a modern instruction-edit graph
(Qwen-Image-Edit 2511 GGUF + a 4-step Lightning LoRA). Its `prompt` is an **edit instruction** encoded by
`TextEncodeQwenImageEditPlus`, so the map key is `prompt` (not the `text` that `CLIPTextEncode` uses). The Plus encoder
bakes the reference image into the conditioning, `FluxKontextImageScale` (node 60) snaps the source to a supported edit
resolution, and `FluxKontextMultiReferenceLatentMethod` (node 43) anchors the edit - which lets the KSampler run at
`denoise 1` (the source latent only sets the output resolution). As with Kontext below, lowering `denoise` is the wrong
knob, so its map exposes none; `CFGNorm` (node 75) stabilises the cfg-1 Lightning setup.

The third, [`../comfyui/flux-kontext.api.json`](../comfyui/flux-kontext.api.json), is a **FLUX.1 Kontext**
instruction-edit graph. Like the Qwen graph it anchors the source through a `ReferenceLatent` (node 43) and runs at
`denoise 1` rather than img2img low-`denoise`, so it follows the edit instruction strongly while keeping the subject -
lowering `denoise` is the wrong knob for it, which is why its map exposes none. Flux is also cfg-1 with a
`ConditioningZeroOut` (node 40) negative, so the real guidance knob is `FluxGuidance` (node 35): the example maps the
tool's `cfg` param there rather than at the KSampler.

Two **FLUX.2 [klein] 9B** graphs round out the set, both loading GGUF weights via `UnetLoaderGGUF` and the Qwen3-8B text
encoder via `CLIPLoaderGGUF` (`type: flux2`) alongside the `flux2-vae`.
[`../comfyui/flux2-t2i.api.json`](../comfyui/flux2-t2i.api.json) is text-to-image: it samples with
`SamplerCustomAdvanced` (a `RandomNoise` seed, `Flux2Scheduler` sigmas, and a `KSamplerSelect` euler), and because
FLUX.2 is guided through a `CFGGuider` the example maps `cfg` there rather than at a KSampler. `width` / `height` map to
two `PrimitiveInt` nodes (6 / 7) that feed both `Flux2Scheduler` and `EmptyFlux2LatentImage`, so a single injection
keeps the resolution-dependent sigma shift and the latent size in lockstep.
[`../comfyui/flux2-edit.api.json`](../comfyui/flux2-edit.api.json) is the instruction-edit variant: the uploaded `image`
is scaled to ~1 MP, VAE-encoded, and anchored into both the positive and negative conditioning through `ReferenceLatent`
(nodes 24 / 25), with `GetImageSize` driving the output dimensions. As with Kontext and Qwen above it runs at
`denoise 1` (the empty latent only sets resolution), so its map exposes neither `denoise` nor `width` / `height` - the
edit follows the source size.

Each ships in two flavours: the base graph (`flux2-t2i` / `flux2-edit`, undistilled, ~20 steps at cfg 5) and a distilled
`*-fast` graph (`flux2-t2i-fast` / `flux2-edit-fast`, 4 steps at cfg 1) that swaps in the distilled diffusion GGUF. The
distilled variants are the practical interactive default; the base edit in particular is heavy - the reference image
inflates the token sequence the diffusion model processes every step - so a slow or VRAM-constrained server may need a
larger `timeoutMs` or a `background: true` submission. A smaller GGUF text-encoder quant frees VRAM for the diffusion
model and noticeably cuts the per-step time. All four route the diffusion model through a `ModelPatchTorchSettings`
(node 16, `enable_fp16_accumulation`) before the `CFGGuider`, which speeds up matmuls on Ampere/Ada GPUs (requires
PyTorch >= 2.7; it is a no-op otherwise). They also route the diffusion model through an empty
`Power Lora Loader (rgthree)` (node 17) - a passthrough until you toggle LoRAs into its list, so model-only FLUX.2 LoRAs
can be stacked without re-wiring the graph.

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

| Variable              | Effect                                                                            |
| --------------------- | --------------------------------------------------------------------------------- |
| `PI_COMFYUI_DISABLED` | Skip the extension entirely.                                                      |
| `PI_COMFYUI_URL`      | Override the configured `baseUrl`.                                                |
| `PI_COMFYUI_TOKEN`    | Convention for a token referenced by `authHeader.value` as `${PI_COMFYUI_TOKEN}`. |

Auth headers are sent on every HTTP request. ComfyUI's websocket does not carry custom headers, so on an authenticated
server the progress stream may not connect; polling still drives completion regardless.

## Command

`/comfyui` reports status: resolved base URL and reachability (a `GET /system_stats` ping), whether an auth header is
configured, the default workflow, the configured workflow names, and `saveDir`. `/comfyui workflows` loads each
configured workflow file and validates that every mapped node id exists in the graph, so a bad input map is caught
without a generation round-trip. `/comfyui jobs` lists the current session's background generations and their status.

## Hot reload

Edit [`comfyui.ts`](./comfyui.ts) or any companion under [`../../../lib/node/pi/comfyui/`](../../../lib/node/pi/comfyui)
and run `/reload` in an interactive pi session. The tool registration, workflow list, and tool description are computed
at load time, so a `/reload` re-runs registration and picks up changes to `comfyui.json` / the workflow graphs. The
`session_shutdown` handler clears the `comfyui` statusline badge (`▦ img:N`) and drops the in-memory background-job
registry on reload, so a stale job count never bleeds into the next session. The jobs themselves run server-side and are
not re-attached after reload - ComfyUI keeps each prompt under its id, so re-collect via the server's own history if a
generation was in flight.

## Related docs

- [README.md](./README.md) - extension index.
- [`../../../lib/node/pi/comfyui/`](../../../lib/node/pi/comfyui) - the pure helpers this shell composes.
- [ComfyUI OpenAPI spec](https://github.com/Comfy-Org/ComfyUI/blob/main/openapi.yaml) - endpoint reference.
