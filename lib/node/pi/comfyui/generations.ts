/**
 * Pure, persisted registry of completed ComfyUI generations.
 *
 * Where {@link ../comfyui/jobs.ts} tracks the in-flight lifecycle of a
 * background job, this module records every render that actually landed on
 * disk - foreground, collected-background, and ephemeral - as an
 * addressable {@link GenerationRecord} with a short id (`g1`, `g2`, …). The
 * record stores the resolved values that were submitted (workflow, prompt,
 * negative, seed, dims, saved paths) so a later call can reproduce or vary
 * it (`variationOf` / `refine`).
 *
 * Persistence mirrors the context-edit / todo reducers: each mutation
 * writes the FULL post-mutation registry as a `custom` session entry, and
 * {@link reduceGenerations} replays the branch newest-first to recover the
 * latest snapshot. That keeps the gallery alive across `/reload` + resume
 * and keeps ids monotonic (the persisted `nextId` is the source of truth).
 *
 * No pi imports - testable under vitest with no runtime.
 */

import { findLatestStateInBranch } from '../branch-state.ts';
import type { BranchEntry } from '../branch-state.ts';
import { truncate } from '../shared/strings.ts';
import type { RefineJourney } from './refine.ts';

/** Where a recorded generation came from. */
export type GenerationSource = 'foreground' | 'background' | 'ephemeral';

/** A render that landed on disk, addressable by its short id. */
export interface GenerationRecord {
  /** Registry-local id the model passes to `variationOf` / `refine` (e.g. "g1"). */
  id: string;
  /** Named workflow that produced it. */
  workflow: string;
  /** ComfyUI prompt id, kept for dedup across collect / auto-download. */
  promptId?: string;
  /** Resolved positive prompt actually submitted. */
  prompt: string;
  /** Resolved negative prompt, if any. */
  negative?: string;
  /** Seed used (echoed for reproduce / vary). */
  seed?: number;
  /** Resolved output width, if the workflow set one. */
  width?: number;
  /** Resolved output height, if the workflow set one. */
  height?: number;
  /** Absolute paths written for this generation. */
  savedPaths: string[];
  source: GenerationSource;
  /** Epoch ms when the render landed on disk. */
  createdAt: number;
  /**
   * Auto-refine journey when this render went through the critic loop: the
   * round count, whether the returned image was accepted, its final score,
   * and every render performed (the intermediates are on disk but are NOT
   * separate gallery entries). Absent for an un-refined render.
   */
  refine?: RefineJourney;
  /**
   * Lineage for a standalone `/comfyui refine <gX>`: the source generation id
   * this render was refined FROM. Absent for a fresh `generate_image` render
   * (its journey starts from its own initial render, with no prior source).
   */
  refineOf?: string;
}

/** The whole registry: ordered records plus the next id to hand out. */
export interface GenerationRegistry {
  generations: GenerationRecord[];
  nextId: number;
}

/** Fields a caller supplies when recording a freshly-landed generation. */
export interface NewGeneration {
  workflow: string;
  promptId?: string;
  prompt: string;
  negative?: string;
  seed?: number;
  width?: number;
  height?: number;
  savedPaths: string[];
  source: GenerationSource;
  createdAt: number;
  refine?: RefineJourney;
  refineOf?: string;
}

export function emptyGenerations(): GenerationRegistry {
  return { generations: [], nextId: 1 };
}

export function cloneGenerations(reg: GenerationRegistry): GenerationRegistry {
  return {
    generations: reg.generations.map((g) => ({ ...g, savedPaths: [...g.savedPaths] })),
    nextId: reg.nextId,
  };
}

/** The id the next {@link addGeneration} will assign (e.g. "g3"). */
export function allocateGenerationId(reg: GenerationRegistry): string {
  return `g${reg.nextId}`;
}

/**
 * Append a recorded generation, returning a new registry and the created
 * record. The id is taken from `reg.nextId`, which is then bumped.
 */
export function addGeneration(
  reg: GenerationRegistry,
  gen: NewGeneration,
): { registry: GenerationRegistry; created: GenerationRecord } {
  const id = allocateGenerationId(reg);
  const created: GenerationRecord = {
    id,
    workflow: gen.workflow,
    promptId: gen.promptId,
    prompt: gen.prompt,
    negative: gen.negative,
    seed: gen.seed,
    width: gen.width,
    height: gen.height,
    savedPaths: [...gen.savedPaths],
    source: gen.source,
    createdAt: gen.createdAt,
    ...(gen.refine !== undefined ? { refine: gen.refine } : {}),
    ...(gen.refineOf !== undefined ? { refineOf: gen.refineOf } : {}),
  };
  return {
    registry: { generations: [...reg.generations, created], nextId: reg.nextId + 1 },
    created,
  };
}

export function findGeneration(reg: GenerationRegistry, id: string): GenerationRecord | undefined {
  return reg.generations.find((g) => g.id === id);
}

/**
 * Find the record for a given ComfyUI prompt id, used to keep a background
 * job from being recorded twice (once by the auto-download tick and again
 * by a manual `collect`).
 */
export function findGenerationByPrompt(reg: GenerationRegistry, promptId: string): GenerationRecord | undefined {
  return reg.generations.find((g) => g.promptId === promptId);
}

/**
 * One-line gallery summary of a record, e.g.
 * `[g1] anima · seed 123 · 1024x1024 · 2 images · "a cat on a roof" (foreground)`.
 */
export function formatGenerationLine(rec: GenerationRecord): string {
  const parts = [rec.workflow];
  if (rec.seed !== undefined) parts.push(`seed ${rec.seed}`);
  if (rec.width !== undefined && rec.height !== undefined) parts.push(`${rec.width}x${rec.height}`);
  const n = rec.savedPaths.length;
  parts.push(`${n} image${n === 1 ? '' : 's'}`);
  if (rec.prompt.length > 0) parts.push(`"${truncate(rec.prompt, 60, { collapseWhitespace: true })}"`);
  parts.push(`(${rec.source})`);
  return `[${rec.id}] ${parts.join(' · ')}`;
}

/** Multi-line gallery listing, newest last, or an empty-state note. */
export function formatGallery(reg: GenerationRegistry): string {
  if (reg.generations.length === 0) return '(no generations yet)';
  return reg.generations.map(formatGenerationLine).join('\n');
}

/**
 * Short autocomplete-description hint for one generation: the workflow plus
 * a clipped prompt snippet, e.g. `anima-noupscale · "1girl, solo, …"`. Lets
 * `/comfyui gallery <id>` completions be told apart by content, not just by
 * workflow name.
 */
export function formatGenerationHint(rec: GenerationRecord): string {
  const snippet = truncate(rec.prompt, 50);
  return snippet.length > 0 ? `${rec.workflow} · ${snippet}` : rec.workflow;
}

/**
 * Full, untruncated detail for one generation: the prompt and negative
 * exactly as submitted (the enhanced text when enhancement ran), plus
 * metadata and the files on disk. Used by `/comfyui gallery <id>` so a
 * human can read the whole enhanced prompt the line view clips to 60 chars.
 */
export function formatGenerationDetail(rec: GenerationRecord): string {
  const lines = [`[${rec.id}] ${rec.workflow} (${rec.source})`];
  const meta: string[] = [];
  if (rec.seed !== undefined) meta.push(`seed ${rec.seed}`);
  if (rec.width !== undefined && rec.height !== undefined) meta.push(`${rec.width}x${rec.height}`);
  if (meta.length > 0) lines.push(meta.join(' · '));
  if (rec.refineOf !== undefined) lines.push(`refined from: ${rec.refineOf}`);
  lines.push(`prompt:   ${rec.prompt}`);
  if (rec.negative !== undefined && rec.negative.length > 0) lines.push(`negative: ${rec.negative}`);
  for (const p of rec.savedPaths) lines.push(`file:     ${p}`);
  const refine = rec.refine;
  if (refine !== undefined) {
    const status = refine.accepted ? 'accepted' : 'best effort';
    lines.push(
      `auto-refine: ${refine.rounds} round${refine.rounds === 1 ? '' : 's'} · ${status} · score ${refine.finalScore}`,
    );
    for (const step of refine.journey) {
      const where = step.savedPath !== undefined ? ` -> ${step.savedPath}` : '';
      lines.push(`  - ${step.action} (score ${step.score})${where}`);
    }
  }
  return lines.join('\n');
}

function isGenerationRecord(value: unknown): value is GenerationRecord {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || v.id.length === 0) return false;
  if (typeof v.workflow !== 'string') return false;
  if (typeof v.prompt !== 'string') return false;
  if (!Array.isArray(v.savedPaths)) return false;
  if (!(v.savedPaths as unknown[]).every((p) => typeof p === 'string')) return false;
  if (v.source !== 'foreground' && v.source !== 'background' && v.source !== 'ephemeral') return false;
  if (typeof v.createdAt !== 'number' || !Number.isFinite(v.createdAt)) return false;
  return true;
}

/**
 * Structural guard that `value` is a serialized {@link GenerationRegistry},
 * strict enough that junk in a `custom` entry's `data` is not replayed.
 */
export function isGenerationRegistryShape(value: unknown): value is GenerationRegistry {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.nextId !== 'number' || !Number.isFinite(v.nextId)) return false;
  if (!Array.isArray(v.generations)) return false;
  return (v.generations as unknown[]).every(isGenerationRecord);
}

/**
 * Replay a session branch newest-first and return the latest persisted
 * generation registry, or {@link emptyGenerations} when none exists. The
 * `toolName` sentinel never matches a real tool result, so only the
 * `custom` snapshots feed the reducer.
 */
export function reduceGenerations(branch: readonly BranchEntry[], customType: string): GenerationRegistry {
  return (
    findLatestStateInBranch(branch, ' comfyui-no-tool', customType, isGenerationRegistryShape, cloneGenerations) ??
    emptyGenerations()
  );
}
