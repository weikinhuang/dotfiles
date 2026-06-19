/**
 * Load a sprite {@link ContentManifest} for the avatar generation tools.
 *
 * The committed manifest (config/pi/avatar/tools/sprite-manifest.ts) is the
 * default, character-agnostic source of truth. A device-local character set
 * ships its own manifest module (built with `makeManifest`, exported as
 * `manifest`) and is selected with `--manifest <path>` on print-prompts.ts,
 * gen-sprite-doc.ts, and slice-sheets.ts - so character-specific emotes stay
 * out of the committed tree while reusing the same prompt/slice engine.
 *
 * The external module is loaded with a dynamic `import()` of its file URL;
 * Node 24's type stripping runs the `.ts` module directly, just like the tools.
 */

import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { type ContentManifest, manifest as defaultManifest } from './sprite-manifest.ts';

/** Structural check that a dynamically-imported module exposes a usable manifest. */
export function isContentManifest(value: unknown): value is ContentManifest {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.allSheets === 'function' &&
    typeof m.sheetsForTier === 'function' &&
    typeof m.frameDescriptions === 'function' &&
    typeof m.frameCountForState === 'function' &&
    typeof m.tierOf === 'function' &&
    typeof m.isGuardedTier === 'function' &&
    Array.isArray(m.TIERS) &&
    Array.isArray(m.ALL_STATES) &&
    typeof m.GROUPS === 'object' &&
    m.GROUPS !== null
  );
}

/**
 * Resolve the manifest to use. With no `path` (the default), return the
 * committed manifest. Otherwise dynamically import the module at `path` and
 * return its exported `manifest`, validating it structurally first.
 */
export async function loadManifest(path?: string): Promise<ContentManifest> {
  if (path === undefined || path.length === 0) return defaultManifest;
  const abs = isAbsolute(path) ? path : resolve(path);
  const mod = (await import(pathToFileURL(abs).href)) as { manifest?: unknown };
  if (!isContentManifest(mod.manifest)) {
    throw new Error(
      `Manifest at ${path} must export a \`manifest\` built with makeManifest(...) ` +
        `(an object with allSheets/sheetsForTier/frameDescriptions/tierOf/isGuardedTier, TIERS, ALL_STATES, GROUPS).`,
    );
  }
  return mod.manifest;
}
