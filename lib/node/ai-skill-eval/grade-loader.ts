// Shared per-iteration grade loading used by `report.ts` and
// `benchmark.ts`.
//
// Both modules walked `<workspace>/<skill>/iteration-<N>/<config>/grades/*.json`
// with nearly-identical code: list configs, open each `<evalId>.json`,
// JSON.parse, stamp the missing `config` field when loading an old
// grade record, swallow parse errors. The only difference was that
// `loadGrades` returns a flat list while the benchmark aggregator
// wanted a per-config grouping so it could pair grade records with
// sibling `.meta.json` sidecars. Both now delegate here.
//
// SPDX-License-Identifier: MIT

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { type GradeConfig, type GradeRecord } from './types.ts';

/** Canonical config order (matches the on-disk directory layout). */
export const GRADE_CONFIGS: readonly GradeConfig[] = ['with_skill', 'without_skill'];

/**
 * Walk every `<config>/grades/*.json` under `iterationDir` and return
 * the parsed grade records in directory-sorted order. Grade records
 * missing the `config` field (pre-R2 workspaces) are stamped with the
 * directory they were read from. Malformed JSON files are silently
 * skipped — matches the report behaviour callers already depend on.
 */
export function loadIterationGrades(iterationDir: string): GradeRecord[] {
  const out: GradeRecord[] = [];
  if (!existsSync(iterationDir)) return out;
  for (const config of GRADE_CONFIGS) {
    const gradesDir = join(iterationDir, config, 'grades');
    if (!existsSync(gradesDir)) continue;
    for (const gf of readdirSync(gradesDir).sort()) {
      if (!gf.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(readFileSync(join(gradesDir, gf), 'utf8')) as GradeRecord;
        if (!raw.config) raw.config = config;
        out.push(raw);
      } catch {
        // Ignore malformed grade files — the report / benchmark skip them.
      }
    }
  }
  return out;
}
