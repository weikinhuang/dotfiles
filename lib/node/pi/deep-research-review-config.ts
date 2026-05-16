/**
 * One-time consent flag for the Phase-4 deep-research review loop.
 *
 * The iteration-loop extension treats `check declare` as a hybrid
 * authorship step: the model drafts a spec, the user reviews /
 * accepts it before `check run` is allowed. `/research` wants to
 * chain two checks (structural + critic) without a user prompt on
 * every refinement iteration. We solve that by recording a
 * persistent consent signal: after the user first runs `/research`
 * and lets the review loop run, subsequent runs auto-accept both
 * check drafts.
 *
 * The flag is stored as a `reference`-type memory entry on disk
 * under the user's global memory root, so the preference survives
 * sessions, pi restarts, and across workspaces - exactly what the
 * plan calls for ("auto-accept both under a one-time consent flag
 * stored via `memory`"). Using the memory directory (rather than a
 * bespoke config file) keeps the consent surface greppable from
 * the same place the user inspects all other cross-session
 * preferences.
 *
 * No pi imports - this module is unit-testable under vitest with a
 * temp memory root.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteFile, ensureDirSync } from './atomic-write.ts';
import { memoryRoot } from './memory-paths.ts';
import { parseFrontmatter } from './memory-reducer.ts';

/**
 * File basename (without `.md`). Kept short + distinctive so the
 * generated memory file reads naturally in the user's MEMORY.md
 * index.
 */
const CONSENT_SLUG = 'deep-research-review-auto-accept';

/**
 * Description string embedded in the memory frontmatter. Surfaces
 * in `MEMORY.md` indexes and memory-search results.
 */
const CONSENT_DESCRIPTION =
  'User consent to let /research auto-accept structural + subjective iteration-loop checks without per-run prompt.';

export interface ReviewConsentState {
  /** True iff the user has previously consented. */
  consented: boolean;
  /** ISO8601 timestamp of the recorded consent, if any. */
  at: string | null;
}

export interface ReviewConsentOpts {
  /**
   * Override the memory root. Tests pass a temp dir; production
   * callers leave it unset (we default to `memoryRoot()`, which
   * honors `PI_MEMORY_ROOT`).
   */
  root?: string;
  /** Injected clock for deterministic `at` timestamps. */
  now?: () => Date;
}

/**
 * Absolute path of the consent memory file. Under
 * `<root>/global/reference/deep-research-review-auto-accept.md`.
 * Exported so tests can assert the write landed at the expected
 * location.
 */
export function consentPath(opts: ReviewConsentOpts = {}): string {
  const root = opts.root ?? memoryRoot();
  return join(root, 'global', 'reference', `${CONSENT_SLUG}.md`);
}

/**
 * Read the current consent state. Returns
 * `{ consented: false, at: null }` when the file is missing
 * (first-run path) OR when the file exists but its frontmatter
 * doesn't satisfy the `reference`-memory contract
 * (`parseFrontmatter` returns null). A file that does parse but
 * lacks an `acceptedAt:` line still counts as consented with
 * `at: null` - the user clearly consented at some point, the
 * timestamp is just missing metadata.
 */
export function readConsent(opts: ReviewConsentOpts = {}): ReviewConsentState {
  const p = consentPath(opts);
  if (!existsSync(p)) return { consented: false, at: null };
  let body: string;
  try {
    body = readFileSync(p, 'utf8');
  } catch {
    return { consented: false, at: null };
  }
  // Gate "consented" on the memory-reducer's strict frontmatter
  // parse. A file without `type`/`name`/`description` headers is
  // treated as malformed - safer than trusting mere existence,
  // so a stray text file cannot silently opt the user into
  // auto-accept. Malformed file → `consented: false`.
  const parsed = parseFrontmatter(body);
  if (parsed?.frontmatter.type !== 'reference') {
    return { consented: false, at: null };
  }
  // `acceptedAt` is an extra (unknown) frontmatter key that
  // `parseFrontmatter` intentionally ignores for forward-compat,
  // so we pull it out of the raw source directly. Anchoring to
  // start-of-line keeps a stray `acceptedAt:` inside the body
  // from leaking in.
  const m = /^acceptedAt:\s*(.+?)\s*$/m.exec(body);
  return { consented: true, at: m ? (m[1] ?? null) : null };
}

/**
 * Record the consent. Idempotent - calling twice overwrites the
 * timestamp but does not change behavior.
 */
export function recordConsent(opts: ReviewConsentOpts = {}): ReviewConsentState {
  const p = consentPath(opts);
  const at = (opts.now ? opts.now() : new Date()).toISOString();
  const body =
    `---\n` +
    `type: reference\n` +
    `name: deep research review auto accept\n` +
    `description: ${CONSENT_DESCRIPTION}\n` +
    `acceptedAt: ${at}\n` +
    `---\n\n` +
    `The user consented to /research's Phase-4 review loop auto-accepting the structural + subjective iteration-loop check drafts on every run. Delete this file to revoke the consent - the next /research will re-prompt on the first review pass.\n`;
  ensureDirSync(join(opts.root ?? memoryRoot(), 'global', 'reference'));
  atomicWriteFile(p, body);
  return { consented: true, at };
}
