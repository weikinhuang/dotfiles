#!/usr/bin/env node
/**
 * List the model files available on a self-hosted ComfyUI server, grouped by the
 * loader node that exposes them. Use it to discover the real filenames to drop
 * into the avatar workflow graphs (the `PLACEHOLDER-*` entries in
 * avatar-ref/*.api.json) without hand-rolling a curl against `/object_info`.
 *
 * Standalone CLI - no pi extension runtime. Reuses the same server + auth wiring
 * (`PI_COMFYUI_URL`, comfyui.json auth header) as gen-comfyui.ts.
 *
 * Usage:
 *   node list-models.ts                 # human-readable, all loader categories
 *   node list-models.ts --json          # machine-readable {label,node,input,models}[]
 *   node list-models.ts --server http://127.0.0.1:8188
 */

import { pathToFileURL } from 'node:url';

import { fetchObjectInfo, type Conn } from '../../../../lib/node/pi/comfyui/client.ts';
import { loadComfyuiConfig, resolveAuthHeaders } from '../../../../lib/node/pi/comfyui/config.ts';

const DEFAULT_SERVER = 'http://127.0.0.1:8188';
const TIMEOUT_MS = 30_000;

/** A loader node input that exposes an enum list of model filenames. */
export interface ModelSource {
  label: string;
  node: string;
  input: string;
}

/** Loader node inputs whose first enum element is the list of installed files. */
export const MODEL_SOURCES: ModelSource[] = [
  { label: 'checkpoints', node: 'CheckpointLoaderSimple', input: 'ckpt_name' },
  { label: 'unet', node: 'UNETLoader', input: 'unet_name' },
  { label: 'unet (gguf)', node: 'UnetLoaderGGUF', input: 'unet_name' },
  { label: 'vae', node: 'VAELoader', input: 'vae_name' },
  { label: 'clip', node: 'CLIPLoader', input: 'clip_name' },
  { label: 'clip (gguf)', node: 'CLIPLoaderGGUF', input: 'clip_name' },
  { label: 'dual clip', node: 'DualCLIPLoader', input: 'clip_name1' },
  { label: 'clip_vision', node: 'CLIPVisionLoader', input: 'clip_name' },
  { label: 'loras', node: 'LoraLoader', input: 'lora_name' },
  { label: 'loras (model-only)', node: 'LoraLoaderModelOnly', input: 'lora_name' },
  { label: 'ipadapter', node: 'IPAdapterModelLoader', input: 'ipadapter_file' },
  { label: 'style_model', node: 'StyleModelLoader', input: 'style_model_name' },
];

/** One resolved category: which loader exposed it and the files it offers. */
export interface ModelList {
  label: string;
  node: string;
  input: string;
  models: string[];
}

export interface ListOpts {
  server: string;
  json: boolean;
  headers: Record<string, string>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

/**
 * Pull the enum filename list for a single loader input out of a parsed
 * `/object_info` payload. ComfyUI shapes each input as `[[...options], {meta}]`,
 * so the model list is the first element of the input spec. Returns undefined
 * when the node/input is absent (e.g. a custom node that is not installed).
 */
export function extractModelList(objectInfo: Record<string, unknown>, source: ModelSource): string[] | undefined {
  const node = asRecord(objectInfo[source.node]);
  const input = asRecord(node?.input);
  const spec = asRecord(input?.required)?.[source.input] ?? asRecord(input?.optional)?.[source.input];
  if (!Array.isArray(spec) || spec.length === 0) return undefined;
  const options: unknown = spec[0];
  if (!Array.isArray(options)) return undefined;
  return options.filter((item): item is string => typeof item === 'string');
}

/** Resolve every {@link MODEL_SOURCES} category present on the server. */
export function extractModelLists(
  objectInfo: Record<string, unknown>,
  sources: ModelSource[] = MODEL_SOURCES,
): ModelList[] {
  const out: ModelList[] = [];
  for (const source of sources) {
    const models = extractModelList(objectInfo, source);
    if (models !== undefined) {
      out.push({ label: source.label, node: source.node, input: source.input, models });
    }
  }
  return out;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ListOpts {
  const opts: ListOpts = {
    server: (env.PI_COMFYUI_URL?.trim() ?? DEFAULT_SERVER).replace(/\/+$/, ''),
    json: false,
    headers: {},
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const next = (): string => {
      const value = inline ?? argv[++i];
      if (value === undefined) {
        throw new Error(`Missing value for ${key}`);
      }
      return value;
    };

    switch (key) {
      case '-h':
      case '--help':
        process.stdout.write('Usage: node list-models.ts [--server <url>] [--json]\n');
        process.exit(0);
        break;
      case '--server':
        opts.server = next().replace(/\/+$/, '');
        break;
      case '--json':
        opts.json = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return opts;
}

/** Render the resolved lists as an aligned, human-readable report. */
export function formatLists(lists: ModelList[]): string {
  if (lists.length === 0) return 'No loader nodes with model lists found on the server.\n';
  const blocks = lists.map((list) => {
    const header = `${list.label}  (${list.node}.${list.input}) - ${list.models.length}`;
    const body = list.models.length === 0 ? '  (none)' : list.models.map((m) => `  ${m}`).join('\n');
    return `${header}\n${body}`;
  });
  return `${blocks.join('\n\n')}\n`;
}

function resolveHeaders(cwd: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const config = loadComfyuiConfig(cwd, { file: '', inputs: {} });
  return resolveAuthHeaders(config, env);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  opts.headers = resolveHeaders(process.cwd());
  const conn: Conn = { base: opts.server, headers: opts.headers, timeoutMs: TIMEOUT_MS };
  let objectInfo: Record<string, unknown>;
  try {
    objectInfo = await fetchObjectInfo(conn, AbortSignal.timeout(TIMEOUT_MS));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)} (server ${opts.server})\n`);
    process.exit(1);
  }
  const lists = extractModelLists(objectInfo);
  process.stdout.write(opts.json ? `${JSON.stringify(lists, null, 2)}\n` : formatLists(lists));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
