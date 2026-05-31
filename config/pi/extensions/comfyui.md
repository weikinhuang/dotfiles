# comfyui

A local/remote [ComfyUI](https://github.com/comfyanonymous/ComfyUI) image-generation tool for pi. Registers a single
`generate_image` tool the model calls to render an image, plus a `/comfyui` status command. The result is returned
inline as a multimodal tool result, so it renders in the terminal and is visible to vision-capable models.

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
   line (best-effort - websocket failures, including auth, fall back silently to polling).
7. Fetch each output via `GET /view`, write the PNG(s) to `saveDir`, and return them inline with a one-line summary.

A non-2xx `POST /prompt` (e.g. unknown checkpoint, bad dimension) surfaces ComfyUI's validation body as an `isError`
tool result so the model can self-correct.

## Tool: `generate_image`

| Parameter     | Type    | Notes                                                         |
| ------------- | ------- | ------------------------------------------------------------- |
| `prompt`      | string  | Required. Positive prompt.                                    |
| `negative`    | string  | Negative prompt.                                              |
| `workflow`    | string  | Named workflow; defaults to `defaultWorkflow`.                |
| `width`       | number  | Output width in pixels.                                       |
| `height`      | number  | Output height in pixels.                                      |
| `steps`       | number  | Sampler steps.                                                |
| `cfg`         | number  | CFG / guidance scale.                                         |
| `seed`        | number  | Omit for a fresh random seed; pass a prior seed to reproduce. |
| `denoise`     | number  | Denoise strength (img2img), `0`-`1`.                          |
| `inputImage`  | string  | Path to an input image (img2img workflows only).              |
| `count`       | number  | Batch size.                                                   |
| `sendToModel` | boolean | Override the `sendToModel` config default for this call.      |

Each parameter is injected only if the active workflow's input map names a node for it. Passing an arg the workflow does
not map (or pointing `inputImage` at a workflow with no `image` mapping) returns a clear error rather than a silent
no-op.

## Configuration

Config layers lowest to highest: the shipped `txt2img` default, then `~/.pi/agent/comfyui.json`, then
`<cwd>/.pi/comfyui.json`.

| Key               | Default                  | Meaning                                                                                       |
| ----------------- | ------------------------ | --------------------------------------------------------------------------------------------- |
| `baseUrl`         | `http://127.0.0.1:8188`  | ComfyUI server origin. Supports `${ENV}`. `PI_COMFYUI_URL` overrides it.                      |
| `authHeader`      | (none)                   | `{ "name", "value" }` sent on every request; `value` supports `${ENV}`.                       |
| `timeoutMs`       | `180000`                 | Hard cap per generation before it is aborted.                                                 |
| `saveDir`         | `.pi/comfyui-out`        | Where PNGs are written (relative to cwd, or an absolute path).                                |
| `defaultWorkflow` | `txt2img`                | Workflow used when the tool call omits `workflow`.                                            |
| `sendToModel`     | `true`                   | Return the image in the tool result (fed to the model next turn). `false` saves to disk only. |
| `workflows`       | `{ txt2img: <shipped> }` | Named workflows; merge by name across layers.                                                 |

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
  },
}
```

Export a workflow from ComfyUI with "Save (API Format)", drop it somewhere readable, and point `file` at it. The `batch`
map key receives the tool's `count` arg; the `image` map key receives the uploaded `inputImage` name. To get the node
ids, open the API-format JSON (its top-level keys are the node ids) or enable node-id badges in the ComfyUI canvas.

The shipped default [`../comfyui/txt2img.api.json`](../comfyui/txt2img.api.json) is the classic SD1.5 graph; it expects
a `v1-5-pruned-emaonly.safetensors` checkpoint to be installed on the server. Repoint `defaultWorkflow` / `workflows` at
your own graph + checkpoint as needed.

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
without a generation round-trip.

## Related docs

- [README.md](./README.md) - extension index.
- [`../../../lib/node/pi/comfyui/`](../../../lib/node/pi/comfyui) - the pure helpers this shell composes.
- [ComfyUI OpenAPI spec](https://github.com/Comfy-Org/ComfyUI/blob/main/openapi.yaml) - endpoint reference.
