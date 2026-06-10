#!/usr/bin/env node
/**
 * Drive a self-hosted ComfyUI server to generate avatar sprite cells from
 * sprite-manifest.ts prompts and a device-local workflow registry.
 *
 * Standalone CLI - no pi extension runtime. Reuses pi-import-free helpers
 * from lib/node/pi/comfyui/.
 *
 * Usage:
 *   node gen-comfyui.ts --ping
 *   node gen-comfyui.ts --workflow anima --hero --canonical avatar-ref/char-art.png   # bootstrap the hero bust
 *   node gen-comfyui.ts --workflow anima --group activities --dry-run
 *   node gen-comfyui.ts --workflow anima --workflow kontext --canonical avatar-ref/canonical.png \
 *     --group activities --states hi,idle --limit 4
 *
 * Hero bootstrap (`--hero`): generates the one canonical bust each other sprite
 * is matched against. For an edit-role workflow, --canonical points at your
 * ORIGINAL character art (the source it edits into pixel art); for a
 * generate-role workflow it is txt2img. Pick the best result and save it as
 * avatar-ref/canonical.png, then run the normal per-cell generation with
 * --canonical avatar-ref/canonical.png.
 *
 * Reference bootstraps also include `--turnaround` (bust, 4 angles), `--full-body`,
 * and `--full-body-turnaround`. These write <kind>.<seed>.png into the same output
 * tree and are optional identity references (plain background, not sliced).
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { atomicWriteFile } from '../../../../lib/node/pi/atomic-write.ts';
import {
  fetchImageBytes,
  pingServer,
  submitPrompt,
  uploadImage,
  waitForImages,
  type Conn,
} from '../../../../lib/node/pi/comfyui/client.ts';
import { loadComfyuiConfig, resolveAuthHeaders } from '../../../../lib/node/pi/comfyui/config.ts';
import { injectInputs, randomSeed } from '../../../../lib/node/pi/comfyui/workflow.ts';
import { cellPrompt, normalizeIdentity, referencePrompt, type ReferenceKind } from './prompt-lib.ts';
import { GROUPS, frameCount, groupOf } from './sprite-manifest.ts';
import { DEFAULT_REGISTRY_PATH, loadAndValidateRegistry, type ValidatedWorkflow } from './workflow-registry.ts';

const DEFAULT_SERVER = 'http://127.0.0.1:8188';
const DEFAULT_IDENTITY_FILE = 'avatar-ref/identity.txt';
const DEFAULT_OUT = 'avatar-ref/gen';
const TIMEOUT_MS = 180_000;

/** One (group, state, frame) generation job. */
export interface GenCell {
  group: string;
  state: string;
  frame: number;
}

export interface GenOpts {
  server: string;
  workflows: string[];
  group: string;
  states: string[];
  limit: number | undefined;
  identityFile: string;
  canonical: string;
  seed: number | undefined;
  steps: number | undefined;
  cfg: number | undefined;
  denoise: number | undefined;
  out: string;
  negative: string | undefined;
  ping: boolean;
  dryRun: boolean;
  reference: ReferenceKind | undefined;
  registryPath: string;
  /** Auth (and any other) request headers, resolved from comfyui.json in main(). */
  headers: Record<string, string>;
}

/**
 * Resolve request headers (e.g. the `Authorization` token) from the shared
 * comfyui config layers (`~/.pi/agent/comfyui.json` + `<cwd>/.pi/comfyui.json`),
 * applying `${ENV}` interpolation. The standalone tool reuses the same auth
 * wiring as the generic comfyui extension instead of going in bare.
 */
function resolveHeaders(cwd: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const config = loadComfyuiConfig(cwd, { file: '', inputs: {} });
  return resolveAuthHeaders(config, env);
}

function parseNumber(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${flag} requires a number, got "${raw}"`);
  }
  return value;
}

function splitStates(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): GenOpts {
  const opts: GenOpts = {
    server: (env.PI_COMFYUI_URL?.trim() ?? DEFAULT_SERVER).replace(/\/+$/, ''),
    workflows: [],
    group: '',
    states: [],
    limit: undefined,
    identityFile: DEFAULT_IDENTITY_FILE,
    canonical: '',
    seed: undefined,
    steps: undefined,
    cfg: undefined,
    denoise: undefined,
    out: DEFAULT_OUT,
    negative: undefined,
    ping: false,
    dryRun: false,
    reference: undefined,
    registryPath: DEFAULT_REGISTRY_PATH,
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
        process.stdout.write(
          'Usage: node gen-comfyui.ts [--server <url>] [--workflow <name>]... [--group <name>]\n' +
            '       [--states a,b,c] [--limit N] [--identity-file <path>] [--canonical <img>]\n' +
            '       [--seed N] [--steps N] [--cfg N] [--denoise N] [--out <dir>] [--negative <text>]\n' +
            '       [--registry <path>] [--hero|--turnaround|--full-body|--full-body-turnaround] [--ping] [--dry-run]\n',
        );
        process.exit(0);
        break;
      case '--server':
        opts.server = next().replace(/\/+$/, '');
        break;
      case '--workflow':
        opts.workflows.push(next());
        break;
      case '--group':
        opts.group = next().toLowerCase();
        break;
      case '--states':
        opts.states = splitStates(next());
        break;
      case '--limit':
        opts.limit = parseNumber(next(), '--limit');
        break;
      case '--identity-file':
        opts.identityFile = next();
        break;
      case '--canonical':
        opts.canonical = next();
        break;
      case '--seed':
        opts.seed = parseNumber(next(), '--seed');
        break;
      case '--steps':
        opts.steps = parseNumber(next(), '--steps');
        break;
      case '--cfg':
        opts.cfg = parseNumber(next(), '--cfg');
        break;
      case '--denoise':
        opts.denoise = parseNumber(next(), '--denoise');
        break;
      case '--out':
        opts.out = next();
        break;
      case '--negative':
        opts.negative = next();
        break;
      case '--registry':
        opts.registryPath = next();
        break;
      case '--ping':
        opts.ping = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--hero':
        opts.reference = 'hero';
        break;
      case '--turnaround':
        opts.reference = 'turnaround';
        break;
      case '--full-body':
        opts.reference = 'full-body';
        break;
      case '--full-body-turnaround':
        opts.reference = 'full-body-turnaround';
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return opts;
}

/** FNV-1a 32-bit hash of a string; stable across runs. */
export function hashState(state: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < state.length; i++) {
    hash ^= state.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/** Stable per-state seed: hash(state) + base seed, kept inside ComfyUI's safe range. */
export function stateSeed(state: string, baseSeed: number): number {
  return (baseSeed + hashState(state)) % 1e15;
}

/**
 * Local path for the img2img source image on an edit workflow.
 * Frame 0 uses the canonical bust; later frames edit that state's frame 0 output.
 */
export function sourceImagePath(
  role: 'generate' | 'edit',
  state: string,
  frame: number,
  canonical: string,
  outDir: string,
  workflowName: string,
): string | undefined {
  if (role === 'generate') return undefined;
  if (frame === 0) return canonical;
  return join(outDir, workflowName, `${state}.0.png`);
}

/** Collect manifest cells in deterministic group / state / frame order. */
export function collectCells(groupFilter: string, stateFilter: string[], limit: number | undefined): GenCell[] {
  const cells: GenCell[] = [];

  if (stateFilter.length > 0) {
    for (const state of stateFilter) {
      let group: string;
      if (groupFilter.length > 0) {
        if (!(groupFilter in GROUPS)) {
          throw new Error(`Unknown group "${groupFilter}"`);
        }
        const groupDef = GROUPS[groupFilter];
        if (groupDef === undefined || !groupDef.states.includes(state)) {
          throw new Error(`State "${state}" is not in group "${groupFilter}"`);
        }
        group = groupFilter;
      } else {
        const resolved = groupOf(state);
        if (resolved === undefined) {
          throw new Error(`Unknown state "${state}"`);
        }
        group = resolved;
      }
      const frames = frameCount(group, state);
      for (let frame = 0; frame < frames; frame++) {
        cells.push({ group, state, frame });
      }
    }
  } else if (groupFilter.length > 0) {
    if (!(groupFilter in GROUPS)) {
      throw new Error(`Unknown group "${groupFilter}"`);
    }
    const group = GROUPS[groupFilter];
    if (group === undefined) return cells;
    for (const state of group.states) {
      const frames = frameCount(groupFilter, state);
      for (let frame = 0; frame < frames; frame++) {
        cells.push({ group: groupFilter, state, frame });
      }
    }
  } else {
    for (const [groupName, group] of Object.entries(GROUPS)) {
      for (const state of group.states) {
        const frames = frameCount(groupName, state);
        for (let frame = 0; frame < frames; frame++) {
          cells.push({ group: groupName, state, frame });
        }
      }
    }
  }

  if (limit !== undefined && limit >= 0) {
    return cells.slice(0, limit);
  }
  return cells;
}

function loadIdentity(path: string): string {
  return normalizeIdentity(readFileSync(path, 'utf8'));
}

function resolveWorkflows(names: string[], registryPath: string, cwd: string, home: string): ValidatedWorkflow[] {
  const { workflows, errors } = loadAndValidateRegistry(registryPath, cwd, home);
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
  if (names.length === 0) {
    throw new Error('At least one --workflow <name> is required');
  }

  const byName = new Map(workflows.map((wf) => [wf.name, wf]));
  const resolved: ValidatedWorkflow[] = [];
  for (const name of names) {
    const wf = byName.get(name);
    if (wf === undefined) {
      const known = workflows.map((entry) => entry.name).join(', ');
      throw new Error(`Unknown workflow "${name}". Known: ${known || '(none)'}`);
    }
    resolved.push(wf);
  }
  return resolved;
}

function outputPath(outDir: string, workflowName: string, state: string, frame: number): string {
  return join(outDir, workflowName, `${state}.${frame}.png`);
}

function emitDryRun(cells: GenCell[], identity: string): void {
  for (const cell of cells) {
    const prompt = cellPrompt(cell.group, cell.state, cell.frame, identity);
    const header = `# ${cell.group} / ${cell.state} / frame ${cell.frame}`;
    process.stdout.write(`${header}\n\n${prompt}\n\n${'-'.repeat(72)}\n\n`);
  }
}

/**
 * Inject params into a workflow, submit it, wait for the first output image, and
 * write it to `dest`. For an edit-role workflow `sourcePath` is uploaded and
 * injected as the `image` param; generate-role ignores it.
 */
async function renderImage(
  conn: Conn,
  wf: ValidatedWorkflow,
  prompt: string,
  seed: number,
  sourcePath: string | undefined,
  dest: string,
  opts: GenOpts,
  home: string,
  signal: AbortSignal,
): Promise<void> {
  let uploadedName: string | undefined;
  if (wf.entry.role === 'edit') {
    if (sourcePath === undefined || sourcePath.length === 0) {
      throw new Error(`edit workflow "${wf.name}" requires a source image`);
    }
    process.stderr.write(`uploading ${sourcePath}…\n`);
    uploadedName = await uploadImage(conn, sourcePath, home, signal);
  }

  const injected = injectInputs(wf.graph, wf.entry.inputs, {
    prompt,
    negative: opts.negative,
    seed,
    steps: opts.steps,
    cfg: opts.cfg,
    denoise: opts.denoise,
    image: uploadedName,
  });
  if (injected.errors.length > 0) {
    throw new Error(`workflow mapping error for "${wf.name}": ${injected.errors.join('; ')}`);
  }

  const clientId = randomUUID();
  const promptId = await submitPrompt(conn, injected.workflow, clientId, signal);
  const refs = await waitForImages(conn, promptId, signal);
  const first = refs[0];
  if (first === undefined) {
    throw new Error(`ComfyUI returned no images for ${wf.name} -> ${dest}`);
  }
  const bytes = await fetchImageBytes(conn, first, signal);
  atomicWriteFile(dest, bytes);
  process.stderr.write(`saved ${dest}\n`);
}

async function generateCell(
  conn: Conn,
  wf: ValidatedWorkflow,
  cell: GenCell,
  identity: string,
  opts: GenOpts,
  baseSeed: number,
  home: string,
  signal: AbortSignal,
): Promise<void> {
  const prompt = cellPrompt(cell.group, cell.state, cell.frame, identity, {
    reference: wf.entry.role === 'edit',
  });
  const seed = stateSeed(cell.state, baseSeed);
  const sourcePath = sourceImagePath(wf.entry.role, cell.state, cell.frame, opts.canonical, opts.out, wf.name);
  const dest = outputPath(opts.out, wf.name, cell.state, cell.frame);
  process.stderr.write(`generating ${wf.name} / ${cell.state}.${cell.frame} (seed ${seed})…\n`);
  await renderImage(conn, wf, prompt, seed, sourcePath, dest, opts, home, signal);
}

/**
 * Generate one candidate reference image per run for the given {@link ReferenceKind}
 * (hero bust, turnaround, full body, or full-body turnaround). Edit-role workflows
 * bootstrap from the original character art (`--canonical`); generate-role workflows
 * do txt2img. Candidates are written as <kind>.<seed>.png so re-runs accumulate options.
 */
async function generateReference(
  conn: Conn,
  wf: ValidatedWorkflow,
  kind: ReferenceKind,
  identity: string,
  opts: GenOpts,
  seed: number,
  home: string,
  signal: AbortSignal,
): Promise<void> {
  const prompt = referencePrompt(kind, identity);
  const sourcePath = wf.entry.role === 'edit' ? opts.canonical : undefined;
  if (wf.entry.role === 'edit' && opts.canonical.length === 0) {
    throw new Error(`${kind} edit workflow "${wf.name}" requires --canonical <reference-art>`);
  }
  const dest = join(opts.out, wf.name, `${kind}.${seed}.png`);
  process.stderr.write(`generating ${kind} ${wf.name} (seed ${seed})…\n`);
  await renderImage(conn, wf, prompt, seed, sourcePath, dest, opts, home, signal);
}

async function runWorkflowCells(
  conn: Conn,
  wf: ValidatedWorkflow,
  cells: GenCell[],
  identity: string,
  opts: GenOpts,
  baseSeed: number,
  home: string,
  signal: AbortSignal,
): Promise<void> {
  if (cells.length === 0) return;
  const cell = cells[0];
  if (cell === undefined) return;
  await generateCell(conn, wf, cell, identity, opts, baseSeed, home, signal);
  await runWorkflowCells(conn, wf, cells.slice(1), identity, opts, baseSeed, home, signal);
}

async function runAllWorkflows(
  conn: Conn,
  workflows: ValidatedWorkflow[],
  cells: GenCell[],
  identity: string,
  opts: GenOpts,
  baseSeed: number,
  home: string,
  signal: AbortSignal,
): Promise<void> {
  if (workflows.length === 0) return;
  const wf = workflows[0];
  if (wf === undefined) return;
  await runWorkflowCells(conn, wf, cells, identity, opts, baseSeed, home, signal);
  await runAllWorkflows(conn, workflows.slice(1), cells, identity, opts, baseSeed, home, signal);
}

async function runReferenceWorkflows(
  conn: Conn,
  workflows: ValidatedWorkflow[],
  kind: ReferenceKind,
  identity: string,
  opts: GenOpts,
  seed: number,
  home: string,
  signal: AbortSignal,
): Promise<void> {
  if (workflows.length === 0) return;
  const wf = workflows[0];
  if (wf === undefined) return;
  await generateReference(conn, wf, kind, identity, opts, seed, home, signal);
  await runReferenceWorkflows(conn, workflows.slice(1), kind, identity, opts, seed, home, signal);
}

async function runReference(
  opts: GenOpts,
  workflows: ValidatedWorkflow[],
  kind: ReferenceKind,
  identity: string,
  home: string,
): Promise<void> {
  const conn: Conn = { base: opts.server, headers: opts.headers, timeoutMs: TIMEOUT_MS };
  const seed = opts.seed ?? randomSeed();
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  await runReferenceWorkflows(conn, workflows, kind, identity, opts, seed, home, signal);
}

async function runGeneration(
  opts: GenOpts,
  cells: GenCell[],
  workflows: ValidatedWorkflow[],
  identity: string,
  home: string,
): Promise<void> {
  for (const wf of workflows) {
    if (wf.entry.role === 'edit' && opts.canonical.length === 0) {
      throw new Error(`edit workflow "${wf.name}" requires --canonical <img>`);
    }
  }

  const conn: Conn = { base: opts.server, headers: opts.headers, timeoutMs: TIMEOUT_MS };
  const baseSeed = opts.seed ?? randomSeed();
  const signal = AbortSignal.timeout(TIMEOUT_MS);

  await runAllWorkflows(conn, workflows, cells, identity, opts, baseSeed, home, signal);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cwd = process.cwd();
  const home = homedir();
  let opts: GenOpts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  opts.headers = resolveHeaders(cwd);

  if (opts.ping) {
    const conn: Conn = { base: opts.server, headers: opts.headers, timeoutMs: TIMEOUT_MS };
    const ok = await pingServer(conn);
    process.stdout.write(ok ? `ComfyUI OK at ${opts.server}\n` : `ComfyUI unreachable at ${opts.server}\n`);
    process.exit(ok ? 0 : 1);
  }

  let identity: string;
  try {
    identity = loadIdentity(resolve(cwd, opts.identityFile));
  } catch {
    process.stderr.write(`Failed to read identity file: ${opts.identityFile}\n`);
    process.exit(1);
  }

  const refKind = opts.reference;
  if (refKind !== undefined) {
    if (opts.dryRun) {
      process.stdout.write(`# ${refKind}\n\n${referencePrompt(refKind, identity)}\n`);
      return;
    }
    let refWorkflows: ValidatedWorkflow[];
    try {
      refWorkflows = resolveWorkflows(opts.workflows, opts.registryPath, cwd, home);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    try {
      await runReference(opts, refWorkflows, refKind, identity, home);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    return;
  }

  let cells: GenCell[];
  try {
    cells = collectCells(opts.group, opts.states, opts.limit);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  if (cells.length === 0) {
    process.stderr.write('No cells matched the requested group/states/limit.\n');
    process.exit(1);
  }

  if (opts.dryRun) {
    emitDryRun(cells, identity);
    return;
  }

  let workflows: ValidatedWorkflow[];
  try {
    workflows = resolveWorkflows(opts.workflows, opts.registryPath, cwd, home);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  try {
    await runGeneration(opts, cells, workflows, identity, home);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
