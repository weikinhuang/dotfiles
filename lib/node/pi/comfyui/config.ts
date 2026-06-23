/**
 * Pure config defaults + coercion + layering for the `comfyui` extension.
 *
 * The extension shell reads JSON from disk (shipped default -> user
 * global `~/.pi/agent/comfyui.json` -> project local `<cwd>/.pi/comfyui.json`),
 * feeds each parsed layer through {@link coerceConfigLayer} (untrusted
 * `unknown` -> validated `Partial<ComfyuiConfig>`), then
 * {@link mergeConfigLayers}. Keeping validation + merge + env
 * interpolation here makes the core logic unit-testable without
 * touching the network.
 *
 * {@link loadComfyuiConfig} / {@link loadUserWorkflowNames} additionally
 * do the disk wiring (read the user + project JSON files, coerce, merge)
 * so the extension shell only supplies the shipped-workflow file path -
 * the one piece that is genuinely shell-specific. They read through
 * {@link readJsoncOrUndefined} so a missing / malformed file degrades to
 * an empty layer rather than throwing. Comments and trailing commas in
 * the JSONC config are tolerated.
 *
 * No pi imports.
 */

import { readJsoncOrUndefined } from '../fs-safe.ts';
import { piAgentPath, piProjectPath } from '../pi-paths.ts';

import type {
  AuthHeader,
  ComfyuiConfig,
  GenerationDefaults,
  ImageSlots,
  InputMapping,
  RoleMapping,
  WorkflowConfig,
} from './types.ts';

/**
 * Input map for the shipped `txt2img` example workflow
 * (`config/pi/comfyui/txt2img.api.json`). Pure data - it names the nodes
 * + input keys each tunable param injects into. Only the on-disk file
 * path is shell-specific, so the shell pairs this with its `extDir`
 * join to build the shipped {@link WorkflowConfig}.
 */
export const SHIPPED_WORKFLOW_INPUTS: Record<string, InputMapping> = {
  prompt: { node: '6', key: 'text' },
  negative: { node: '7', key: 'text' },
  seed: { node: '3', key: 'seed' },
  steps: { node: '3', key: 'steps' },
  cfg: { node: '3', key: 'cfg' },
  denoise: { node: '3', key: 'denoise' },
  width: { node: '5', key: 'width' },
  height: { node: '5', key: 'height' },
  batch: { node: '5', key: 'batch_size' },
};

/** Shipped defaults used as the lowest config layer. */
export const DEFAULT_CONFIG: ComfyuiConfig = {
  baseUrl: 'http://127.0.0.1:8188',
  timeoutMs: 180000,
  saveDir: '.pi/comfyui-out',
  defaultWorkflow: 'txt2img',
  sendToModel: true,
  ephemeral: false,
  background: false,
  autoDownload: true,
  pollIntervalMs: 3000,
  enhance: false,
  workflows: {},
};

/** Floor for the auto-download poll interval, so a tiny value can't hammer the server. */
export const MIN_POLL_INTERVAL_MS = 1000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function asAuthHeader(value: unknown): AuthHeader | undefined {
  if (!isObject(value)) return undefined;
  const name = asString(value.name);
  const headerValue = asString(value.value);
  if (name === undefined || headerValue === undefined || name.length === 0) return undefined;
  return { name, value: headerValue };
}

/**
 * Validate the optional `defaults` block. Drops any field with the
 * wrong type; numeric fields must be finite and positive (a 0-px width
 * or 0-step render is never intended). `negative` is a free-form string
 * (empty allowed - an explicit empty negative prompt is meaningful).
 * Returns undefined when no valid field survives so an all-garbage block
 * doesn't pin an empty `defaults` object onto the merged config.
 */
function asGenerationDefaults(value: unknown): GenerationDefaults | undefined {
  if (!isObject(value)) return undefined;
  const out: GenerationDefaults = {};

  const width = asPositiveNumber(value.width);
  if (width !== undefined) out.width = width;
  const height = asPositiveNumber(value.height);
  if (height !== undefined) out.height = height;
  const steps = asPositiveNumber(value.steps);
  if (steps !== undefined) out.steps = steps;
  const cfg = asPositiveNumber(value.cfg);
  if (cfg !== undefined) out.cfg = cfg;
  const denoise = asPositiveNumber(value.denoise);
  if (denoise !== undefined) out.denoise = denoise;
  const count = asPositiveNumber(value.count);
  if (count !== undefined) out.count = count;

  const negative = asString(value.negative);
  if (negative !== undefined) out.negative = negative;

  return Object.keys(out).length > 0 ? out : undefined;
}

function asInputMapping(value: unknown): InputMapping | undefined {
  if (!isObject(value)) return undefined;
  const node = asString(value.node);
  const key = asString(value.key);
  if (node === undefined || key === undefined || node.length === 0 || key.length === 0) return undefined;
  return { node, key };
}

function asInputMap(value: unknown): Record<string, InputMapping> | undefined {
  if (!isObject(value)) return undefined;
  const out: Record<string, InputMapping> = {};
  for (const [name, raw] of Object.entries(value)) {
    const mapping = asInputMapping(raw);
    if (mapping !== undefined) out[name] = mapping;
  }
  return out;
}

function asImageList(value: unknown): InputMapping[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: InputMapping[] = [];
  for (const raw of value) {
    const mapping = asInputMapping(raw);
    if (mapping !== undefined) out.push(mapping);
  }
  return out.length > 0 ? out : undefined;
}

function asRoleMapping(value: unknown): RoleMapping | undefined {
  const base = asInputMapping(value);
  if (base === undefined || !isObject(value)) return undefined;
  const out: RoleMapping = { ...base };
  const kind = asString(value.kind);
  if (kind === 'image' || kind === 'mask') out.kind = kind;
  const invert = asBoolean(value.invert);
  if (invert !== undefined) out.invert = invert;
  return out;
}

function asRoleMap(value: unknown): Record<string, RoleMapping> | undefined {
  if (!isObject(value)) return undefined;
  const out: Record<string, RoleMapping> = {};
  for (const [role, raw] of Object.entries(value)) {
    const mapping = asRoleMapping(raw);
    if (mapping !== undefined) out[role] = mapping;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Coerce the `images` field: an array is positional, an object is role-keyed. */
function asImageSlots(value: unknown): ImageSlots | undefined {
  return Array.isArray(value) ? asImageList(value) : asRoleMap(value);
}

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const raw of value) {
    const s = asString(raw);
    if (s !== undefined && s.length > 0) out.push(s);
  }
  return out.length > 0 ? out : undefined;
}

function asWorkflowConfig(value: unknown): WorkflowConfig | undefined {
  if (!isObject(value)) return undefined;
  const file = asString(value.file);
  if (file === undefined || file.length === 0) return undefined;
  const inputs = asInputMap(value.inputs) ?? {};
  const images = asImageSlots(value.images);
  const wf: WorkflowConfig = { file, inputs };
  if (images !== undefined) wf.images = images;
  const description = asString(value.description);
  if (description !== undefined && description.length > 0) wf.description = description;
  const tags = asStringList(value.tags);
  if (tags !== undefined) wf.tags = tags;
  const promptProtocol = asString(value.promptProtocol);
  if (promptProtocol !== undefined && promptProtocol.length > 0) wf.promptProtocol = promptProtocol;
  const guidanceFile = asString(value.guidanceFile);
  if (guidanceFile !== undefined && guidanceFile.length > 0) wf.guidanceFile = guidanceFile;
  const enhance = asBoolean(value.enhance);
  if (enhance !== undefined) wf.enhance = enhance;
  return wf;
}

function asWorkflows(value: unknown): Record<string, WorkflowConfig> | undefined {
  if (!isObject(value)) return undefined;
  const out: Record<string, WorkflowConfig> = {};
  for (const [name, raw] of Object.entries(value)) {
    const workflow = asWorkflowConfig(raw);
    if (workflow !== undefined) out[name] = workflow;
  }
  return out;
}

/**
 * Validate an untrusted parsed JSON layer into a `Partial<ComfyuiConfig>`,
 * dropping any field with the wrong type. Returns an empty object for a
 * non-object input.
 */
export function coerceConfigLayer(raw: unknown): Partial<ComfyuiConfig> {
  if (!isObject(raw)) return {};
  const out: Partial<ComfyuiConfig> = {};

  const baseUrl = asString(raw.baseUrl);
  if (baseUrl !== undefined && baseUrl.length > 0) out.baseUrl = baseUrl;

  const timeoutMs = asPositiveNumber(raw.timeoutMs);
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;

  const saveDir = asString(raw.saveDir);
  if (saveDir !== undefined && saveDir.length > 0) out.saveDir = saveDir;

  const defaultWorkflow = asString(raw.defaultWorkflow);
  if (defaultWorkflow !== undefined && defaultWorkflow.length > 0) out.defaultWorkflow = defaultWorkflow;

  const sendToModel = asBoolean(raw.sendToModel);
  if (sendToModel !== undefined) out.sendToModel = sendToModel;

  const ephemeral = asBoolean(raw.ephemeral);
  if (ephemeral !== undefined) out.ephemeral = ephemeral;

  const background = asBoolean(raw.background);
  if (background !== undefined) out.background = background;

  const autoDownload = asBoolean(raw.autoDownload);
  if (autoDownload !== undefined) out.autoDownload = autoDownload;

  const pollIntervalMs = asPositiveNumber(raw.pollIntervalMs);
  if (pollIntervalMs !== undefined) out.pollIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, pollIntervalMs);

  const enhance = asBoolean(raw.enhance);
  if (enhance !== undefined) out.enhance = enhance;

  const enhanceModel = asString(raw.enhanceModel);
  if (enhanceModel !== undefined && enhanceModel.length > 0) out.enhanceModel = enhanceModel;

  const enhanceContextChars = asPositiveNumber(raw.enhanceContextChars);
  if (enhanceContextChars !== undefined) out.enhanceContextChars = Math.round(enhanceContextChars);

  const enhanceTimeoutMs = asPositiveNumber(raw.enhanceTimeoutMs);
  if (enhanceTimeoutMs !== undefined) out.enhanceTimeoutMs = enhanceTimeoutMs;

  const enhanceGuidanceFile = asString(raw.enhanceGuidanceFile);
  if (enhanceGuidanceFile !== undefined && enhanceGuidanceFile.length > 0)
    out.enhanceGuidanceFile = enhanceGuidanceFile;

  const previewMaxDimension = asPositiveNumber(raw.previewMaxDimension);
  if (previewMaxDimension !== undefined) out.previewMaxDimension = Math.round(previewMaxDimension);

  const defaults = asGenerationDefaults(raw.defaults);
  if (defaults !== undefined) out.defaults = defaults;

  const authHeader = asAuthHeader(raw.authHeader);
  if (authHeader !== undefined) out.authHeader = authHeader;

  const workflows = asWorkflows(raw.workflows);
  if (workflows !== undefined) out.workflows = workflows;

  return out;
}

/**
 * Layer `overrides` over {@link DEFAULT_CONFIG} in priority order
 * (lowest first). Scalars are replaced wholesale; `authHeader` is
 * replaced wholesale by any layer that sets it; `defaults` merge by
 * field so a higher layer can override one generation default (e.g.
 * `steps`) without dropping the others; `workflows` merge by name so a
 * higher layer can add new workflows or replace one by id without
 * dropping the others.
 */
export function mergeConfigLayers(...overrides: Partial<ComfyuiConfig>[]): ComfyuiConfig {
  const result: ComfyuiConfig = { ...DEFAULT_CONFIG, workflows: { ...DEFAULT_CONFIG.workflows } };

  for (const layer of overrides) {
    if (layer.baseUrl !== undefined) result.baseUrl = layer.baseUrl;
    if (layer.timeoutMs !== undefined) result.timeoutMs = layer.timeoutMs;
    if (layer.saveDir !== undefined) result.saveDir = layer.saveDir;
    if (layer.defaultWorkflow !== undefined) result.defaultWorkflow = layer.defaultWorkflow;
    if (layer.sendToModel !== undefined) result.sendToModel = layer.sendToModel;
    if (layer.ephemeral !== undefined) result.ephemeral = layer.ephemeral;
    if (layer.background !== undefined) result.background = layer.background;
    if (layer.autoDownload !== undefined) result.autoDownload = layer.autoDownload;
    if (layer.pollIntervalMs !== undefined) result.pollIntervalMs = layer.pollIntervalMs;
    if (layer.enhance !== undefined) result.enhance = layer.enhance;
    if (layer.enhanceModel !== undefined) result.enhanceModel = layer.enhanceModel;
    if (layer.enhanceContextChars !== undefined) result.enhanceContextChars = layer.enhanceContextChars;
    if (layer.enhanceTimeoutMs !== undefined) result.enhanceTimeoutMs = layer.enhanceTimeoutMs;
    if (layer.enhanceGuidanceFile !== undefined) result.enhanceGuidanceFile = layer.enhanceGuidanceFile;
    if (layer.previewMaxDimension !== undefined) result.previewMaxDimension = layer.previewMaxDimension;
    if (layer.defaults !== undefined) result.defaults = { ...result.defaults, ...layer.defaults };
    if (layer.authHeader !== undefined) result.authHeader = { ...layer.authHeader };
    if (layer.workflows !== undefined) result.workflows = { ...result.workflows, ...layer.workflows };
  }

  return result;
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Expand `${VAR}` references in `value` from `env`. An undefined or
 * missing variable expands to the empty string, so a configured-but-unset
 * token yields no credential rather than leaking the literal `${VAR}`.
 */
export function interpolateEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(ENV_REF, (_match, name: string) => env[name] ?? '');
}

/**
 * Resolve the effective base URL: `PI_COMFYUI_URL` wins over the config
 * value, then `${ENV}` interpolation is applied and any trailing slash
 * is dropped so URL joining stays predictable.
 */
export function resolveBaseUrl(config: ComfyuiConfig, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_COMFYUI_URL?.trim();
  const raw = override !== undefined && override.length > 0 ? override : config.baseUrl;
  return interpolateEnv(raw, env).replace(/\/+$/, '');
}

/**
 * Build the request-header object from the configured auth header, with
 * `${ENV}` interpolation applied. Returns an empty object when no auth
 * header is configured or the interpolated value is empty.
 */
export function resolveAuthHeaders(
  config: ComfyuiConfig,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (config.authHeader === undefined) return {};
  const value = interpolateEnv(config.authHeader.value, env);
  if (value.length === 0) return {};
  return { [config.authHeader.name]: value };
}

export interface SendDecision {
  /** Whether to return the image in the tool result (fed to the model). */
  send: boolean;
  /** True when sending was suppressed because the model lacks image input. */
  visionBlocked: boolean;
}

/**
 * Decide whether to hand the generated image back to the model.
 *
 * `requested` is the resolved preference (`sendToModel` arg ?? config).
 * Even when requested, sending is suppressed if the active model
 * positively does not accept image input (`modelInput` is an array
 * lacking `"image"`) - feeding a base64 PNG to a text-only model wastes
 * tokens or errors. When `modelInput` is unknown (not an array), the
 * preference is honored as-is so a detection gap never silently drops a
 * supported image.
 */
export function resolveSendToModel(requested: boolean, modelInput: unknown): SendDecision {
  if (!requested) return { send: false, visionBlocked: false };
  if (Array.isArray(modelInput)) {
    const inputs = modelInput as unknown[];
    if (!inputs.includes('image')) return { send: false, visionBlocked: true };
  }
  return { send: true, visionBlocked: false };
}

/**
 * Load the fully-resolved config for `cwd`, layering the shipped
 * `txt2img` default (lowest) under the user-global
 * `<piAgentDir>/comfyui.json` and the project-local `<cwd>/.pi/comfyui.json`.
 *
 * `shipped` is the shell-provided {@link WorkflowConfig} for the example
 * workflow (it owns the on-disk path via `extDir`); everything else -
 * reading + coercing + merging the user / project layers - is done here.
 */
export function loadComfyuiConfig(cwd: string, shipped: WorkflowConfig): ComfyuiConfig {
  const base = { workflows: { txt2img: shipped } };
  const userLayer = coerceConfigLayer(readJsoncOrUndefined(piAgentPath('comfyui.json')));
  const projectLayer = coerceConfigLayer(readJsoncOrUndefined(piProjectPath(cwd, 'comfyui.json')));
  return mergeConfigLayers(base, userLayer, projectLayer);
}

/**
 * Names of the workflows the user contributes via the user-global and
 * project-local config files, ignoring the shipped example default.
 *
 * The extension uses this for its auto-disable decision: the shipped
 * `txt2img` graph expects a checkpoint most servers won't have, so when
 * neither config file adds a workflow the tool is deregistered rather
 * than leaking a broken option into the model's tool list.
 */
export function loadUserWorkflowNames(cwd: string): string[] {
  const userWorkflows = coerceConfigLayer(readJsoncOrUndefined(piAgentPath('comfyui.json'))).workflows ?? {};
  const projectWorkflows = coerceConfigLayer(readJsoncOrUndefined(piProjectPath(cwd, 'comfyui.json'))).workflows ?? {};
  return [...Object.keys(userWorkflows), ...Object.keys(projectWorkflows)];
}
