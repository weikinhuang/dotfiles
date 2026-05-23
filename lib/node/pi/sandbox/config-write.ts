/**
 * Pure JSONC config-mutation helpers used by `sandbox.ts`'s slash
 * commands (`/sandbox-allow`, `/sandbox-deny`, `/sandbox-allow-write`)
 * and by the network ask-callback's `Allow ... save to scope` choice.
 *
 * Each helper reads the existing JSONC config for mutation
 * (`readJsoncForMutation` from `jsonc.ts` - throws `JsoncReadError` if
 * the file exists but is malformed, so a slash-command write never
 * clobbers the user's hand-edited rules), folds in the new rule, and
 * pretty-prints the structured result back to disk.
 *
 * Notes worth keeping in one place:
 *   - The schema types are LOOSE on purpose. The on-disk file is
 *     expected to round-trip through pi's actual sandbox loader
 *     (`config-load.ts`) on the next reconfigure pass; that loader
 *     owns the strict validation. Our schema only describes the
 *     fields we mutate.
 *   - Comments in the original file are NOT preserved across the
 *     round-trip. The user accepts this when they invoke a slash
 *     command (the message says "added X to ..."); a failed parse
 *     surfaces a notify and aborts before the write.
 *
 * Pure module: pi-free; depends on `jsonc.ts` + `atomic-write.ts`
 * only. Unit-tested under `tests/lib/node/pi/sandbox/config-write.spec.ts`.
 */

import { writeJsonFile } from '../atomic-write.ts';
import { readJsoncForMutation } from '../jsonc.ts';

/** Loose shape of `<piAgentDir>/sandbox.json` covering only the
 *  fields the slash commands mutate. */
export interface SandboxJsonShape {
  network?: { allow?: string[]; deny?: string[] };
  unixSockets?: { allow?: string[]; allowAll?: boolean };
  flags?: Record<string, unknown>;
}

/** Loose shape of `<piAgentDir>/filesystem.json` covering only the
 *  fields the slash commands mutate. */
export interface FilesystemJsonShape {
  read?: { deny?: { basenames?: string[]; segments?: string[]; paths?: string[] }; allow?: unknown };
  write?: {
    allow?: { basenames?: string[]; segments?: string[]; paths?: string[] };
    deny?: { basenames?: string[]; segments?: string[]; paths?: string[] };
  };
}

/**
 * Add `domain` to `network.allow` or `network.deny` in the JSONC file
 * at `path`. Idempotent (no-op if the domain is already present),
 * sorts the bucket for stable diffs.
 *
 * Throws {@link JsoncReadError} if the file exists but doesn't parse,
 * so the slash-command handler can abort cleanly without overwriting
 * a user's hand-edited file.
 */
export function addNetworkRule(path: string, kind: 'allow' | 'deny', domain: string): void {
  const cur = readJsoncForMutation<SandboxJsonShape>('sandbox', path, () => ({}));
  cur.network ??= {};
  const bucket = (cur.network[kind] ??= []);
  if (!bucket.includes(domain)) bucket.push(domain);
  bucket.sort();
  writeJsonFile(path, cur);
}

/**
 * Add `pathToAllow` to `write.allow.paths` in the JSONC filesystem-policy
 * file at `path`. Idempotent + sorted for stable diffs. Same throw
 * semantics as {@link addNetworkRule}.
 */
export function addWriteAllowPath(path: string, pathToAllow: string): void {
  const cur = readJsoncForMutation<FilesystemJsonShape>('sandbox', path, () => ({}));
  cur.write ??= {};
  cur.write.allow ??= {};
  cur.write.allow.paths ??= [];
  if (!cur.write.allow.paths.includes(pathToAllow)) cur.write.allow.paths.push(pathToAllow);
  cur.write.allow.paths.sort();
  writeJsonFile(path, cur);
}
