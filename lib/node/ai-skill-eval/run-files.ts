// Shared result-file listing + numeric-sort helpers used by the CLI's
// `grade` path, the benchmark loader, and the blind A/B comparator.
//
// Every `ai-skill-eval run` writes its per-run replies to
// `<iteration>/<config>/results/<eval-id>/run-{1,2,3}.txt`. Multiple
// call sites need to enumerate those files in numeric order — the CLI
// to hand them back to `gradeDeterministic` after the fact, the
// benchmark aggregator to read the sibling `run-*.txt.meta.json`
// sidecars, and the comparator to pick a canonical reply. Before this
// module landed, each site carried its own `^run-\d+\.txt$` regex + an
// inlined numeric sort; they drifted once already.
//
// SPDX-License-Identifier: MIT

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { type GradeConfig } from './types.ts';
import { iterationPath } from './workspace.ts';

const RUN_FILE_RE = /^run-(\d+)\.txt$/;
const META_FILE_RE = /^run-(\d+)\.txt\.meta\.json$/;

/**
 * List entries in `dir` whose basename matches `pattern`, returning each
 * path joined back onto `dir` and sorted by the captured integer. Returns
 * `[]` when `dir` doesn't exist so callers don't have to guard
 * separately. `pattern` must have a capture group whose first match is
 * the numeric run index — the helper's sole job.
 */
function listByRunIndex(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return [];
  const out: { n: number; name: string }[] = [];
  for (const name of readdirSync(dir)) {
    const m = pattern.exec(name);
    if (!m?.[1]) continue;
    out.push({ n: Number.parseInt(m[1], 10), name });
  }
  out.sort((a, b) => a.n - b.n);
  return out.map((e) => join(dir, e.name));
}

/**
 * Absolute path of `<iteration>/<config>/results/<eval-id>/`, the
 * directory every `run-*.txt` and `run-*.txt.meta.json` sibling lands
 * in. Factored out so callers don't repeat the path shape.
 */
export function resultDir(iterationDir: string, config: GradeConfig, evalId: string): string {
  return join(iterationDir, config, 'results', evalId);
}

/** Convenience overload that takes workspace + skill + iteration N. */
export function resultDirAt(
  workspace: string,
  skill: string,
  iteration: number,
  config: GradeConfig,
  evalId: string,
): string {
  return resultDir(iterationPath(workspace, skill, iteration), config, evalId);
}

/**
 * Enumerate every `run-*.txt` file under
 * `<iteration>/<config>/results/<eval-id>/` in numeric order. Used by
 * the `grade` subcommand to rediscover a prior `run`'s output, by the
 * comparator to pick a canonical reply, and by the benchmark loader.
 */
export function listRunFiles(iterationDir: string, config: GradeConfig, evalId: string): string[] {
  return listByRunIndex(resultDir(iterationDir, config, evalId), RUN_FILE_RE);
}

/** Workspace-path overload mirroring {@link resultDirAt}. */
export function listRunFilesAt(
  workspace: string,
  skill: string,
  iteration: number,
  config: GradeConfig,
  evalId: string,
): string[] {
  return listByRunIndex(resultDirAt(workspace, skill, iteration, config, evalId), RUN_FILE_RE);
}

/**
 * Enumerate every `run-*.txt.meta.json` sidecar under the eval's result
 * directory in numeric order. Used by the benchmark aggregator to collect
 * per-run timing + token samples.
 */
export function listRunMetaFiles(evalDir: string): string[] {
  return listByRunIndex(evalDir, META_FILE_RE);
}
