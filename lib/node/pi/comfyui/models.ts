/**
 * Pure extraction of the installed-model lists from a ComfyUI
 * `/object_info` catalog, for the human-facing `/comfyui models` command.
 *
 * ComfyUI advertises every loadable file as a combo-widget enum on the
 * relevant loader node, e.g.
 * `CheckpointLoaderSimple.input.required.ckpt_name[0]` is the array of
 * checkpoint filenames. {@link extractModelCatalog} pulls the lists a
 * person configuring a workflow actually needs (checkpoints, VAEs, LoRAs,
 * …) and ignores the rest of the node graph. Never exposed to the model -
 * it only helps the operator fill in `ckpt_name` / `lora_name` values.
 *
 * No pi imports - testable under vitest.
 */

interface ModelSource {
  /** Catalog category the extracted names land under. */
  category: string;
  /** `/object_info` node class advertising the enum. */
  node: string;
  /** Required-input field whose first element is the filename enum. */
  field: string;
}

/**
 * Loader node + field pairs scanned for installed files. Multiple nodes
 * can feed one category (e.g. both checkpoint loaders); their lists are
 * merged and de-duplicated.
 */
const MODEL_SOURCES: readonly ModelSource[] = [
  { category: 'checkpoints', node: 'CheckpointLoaderSimple', field: 'ckpt_name' },
  { category: 'checkpoints', node: 'CheckpointLoader', field: 'ckpt_name' },
  { category: 'vae', node: 'VAELoader', field: 'vae_name' },
  { category: 'loras', node: 'LoraLoader', field: 'lora_name' },
  { category: 'clip', node: 'CLIPLoader', field: 'clip_name' },
  { category: 'unet', node: 'UNETLoader', field: 'unet_name' },
  { category: 'controlnet', node: 'ControlNetLoader', field: 'control_net_name' },
  { category: 'upscale_models', node: 'UpscaleModelLoader', field: 'model_name' },
];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const arr = value as unknown[];
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item === 'string') out.push(item);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Extract installed-model filename lists from a `/object_info` catalog,
 * keyed by category (`checkpoints`, `vae`, `loras`, …). Each list is
 * de-duplicated and sorted. Categories whose loader node is absent are
 * omitted, so a server without LoRA support simply yields no `loras` key.
 */
export function extractModelCatalog(objectInfo: Record<string, unknown>): Record<string, string[]> {
  const catalog: Record<string, string[]> = {};

  for (const src of MODEL_SOURCES) {
    const node = asRecord(objectInfo[src.node]);
    const input = node === undefined ? undefined : asRecord(node.input);
    const required = input === undefined ? undefined : asRecord(input.required);
    const fieldDef = required === undefined ? undefined : required[src.field];
    if (!Array.isArray(fieldDef)) continue;
    const enumList = asStringArray((fieldDef as unknown[])[0]);
    if (enumList === undefined) continue;
    catalog[src.category] = (catalog[src.category] ?? []).concat(enumList);
  }

  for (const key of Object.keys(catalog)) {
    catalog[key] = [...new Set(catalog[key])].sort();
  }
  return catalog;
}

/**
 * Render a {@link extractModelCatalog} result as a human-readable block
 * for the `/comfyui models` command. Returns a neutral note when nothing
 * matched (e.g. an unreachable or unexpected server).
 */
export function formatModelCatalog(catalog: Record<string, string[]>): string {
  const categories = Object.keys(catalog);
  if (categories.length === 0) return 'no known model lists found in /object_info';

  const lines: string[] = [];
  for (const category of categories) {
    const items = catalog[category];
    lines.push(`${category} (${items.length}):`);
    for (const item of items) lines.push(`  ${item}`);
  }
  return lines.join('\n');
}
