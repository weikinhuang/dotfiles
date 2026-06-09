/**
 * `image-ref` - mark an image path with `&` and have the model *see* it.
 *
 * Pi attaches image bytes to a turn only via the CLI `@file` arg and
 * clipboard paste; an image *path* typed into an interactive session is
 * sent as plain text, so a vision model never gets the pixels and a
 * small local model flails trying to "read" a binary. This extension
 * closes that gap: it hooks the `input` event, finds `&`-marked path
 * tokens that resolve to a real image file on disk, reads + MIME-sniffs
 * + resizes them with pi's own image pipeline, attaches them as
 * `ImageContent`, and rewrites the marked path into a stable
 * `<image name="...">` tag the model can refer back to. Write
 * `&./mock.png` and the agent just sees it.
 *
 * Attachment is OPT-IN by design: only the `&` marker triggers it, so
 * mentioning a bare path in prose ("let's rename Example.jpg") never
 * accidentally base64s a file you only wanted to talk about.
 *
 * This is the *input* counterpart to the `comfyui` extension's *output*
 * (`generate_image` returns rendered images inline). Both resolve a
 * path-to-image; once the model can see a referenced image it can pass
 * that same path into comfyui's `inputImage` for an img2img run itself.
 *
 * The pure logic - byte sniffing, marked-path extraction, text rewrite,
 * config layering, the vision-capability gate - lives under
 * `lib/node/pi/image-ref/` and is unit-tested; this shell is just the pi
 * glue: the `input` transform, the filesystem reads, and the resize call.
 *
 * Config layers (lowest -> highest): shipped defaults ->
 * <piAgentDir>/image-ref.json -> <cwd>/.pi/image-ref.json.
 *
 * A companion autocomplete provider closes the typing loop: typing the
 * `&` marker pops a file-path menu scoped to image files (and
 * directories to drill into), so `&./mock.png` can be tab-completed
 * instead of typed out. It stacks on top of pi's built-in slash/path
 * completion and delegates everything that isn't a `&`-marked token.
 *
 * Environment:
 *   PI_IMAGE_REF_DISABLED=1            skip the extension entirely
 *   PI_IMAGE_REF_DISABLE_COMPLETION=1  keep attachment, drop the `&` autocomplete
 *   PI_IMAGE_REF_DEBUG=1               notify once per attach / skip decision
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';

import {
  type ExtensionAPI,
  type ExtensionContext,
  formatDimensionNote,
  resizeImage,
} from '@earendil-works/pi-coding-agent';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { AutocompleteProvider, AutocompleteSuggestions } from '@earendil-works/pi-tui';

import { envTruthy } from '../../../lib/node/pi/parse-env.ts';
import { expandTilde } from '../../../lib/node/pi/path-expand.ts';
import {
  buildCompletionItems,
  completionPrefix,
  extractMarkerToken,
  resolveReadDir,
} from '../../../lib/node/pi/image-ref/complete.ts';
import { loadImageRefConfig } from '../../../lib/node/pi/image-ref/config.ts';
import { sniffImageMime, SNIFF_BYTES } from '../../../lib/node/pi/image-ref/detect.ts';
import {
  type AttachedRef,
  extractPathTokens,
  MARKER,
  rewriteWithRefs,
} from '../../../lib/node/pi/image-ref/extract.ts';
import { modelAcceptsImages } from '../../../lib/node/pi/image-ref/vision.ts';

/** Cap on completion items surfaced for a single `&` token. */
const MAX_COMPLETIONS = 20;

/**
 * Build the `&`-marker autocomplete provider that stacks on `current`.
 * Returns image-file + directory completions when the cursor sits in a
 * marked token, otherwise delegates wholesale to the built-in provider.
 * `applyCompletion` is delegated too: a `&`-prefixed value falls through
 * pi's generic file-path branch, which splices it in verbatim.
 */
function createCompletionProvider(current: AutocompleteProvider, cwd: string, homedir: string): AutocompleteProvider {
  return {
    triggerCharacters: [MARKER],
    async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
      const line = lines[cursorLine] ?? '';
      const token = extractMarkerToken(line.slice(0, cursorCol));
      if (!token) return current.getSuggestions(lines, cursorLine, cursorCol, options);

      try {
        const entries = await readdir(resolveReadDir(token, cwd, homedir), { withFileTypes: true });
        if (options.signal.aborted) return current.getSuggestions(lines, cursorLine, cursorCol, options);
        const items = buildCompletionItems(
          entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() })),
          token,
          MAX_COMPLETIONS,
        );
        if (items.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
        return { items, prefix: completionPrefix(token) };
      } catch {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

/** Result of trying to turn one path token into an attachment. */
interface Resolved {
  image: ImageContent;
  ref: AttachedRef;
}

export default function imageRefExtension(pi: ExtensionAPI): void {
  if (envTruthy(process.env.PI_IMAGE_REF_DISABLED)) return;
  const debug = envTruthy(process.env.PI_IMAGE_REF_DEBUG);
  const completionEnabled = !envTruthy(process.env.PI_IMAGE_REF_DISABLE_COMPLETION);

  // Resolve a single cleaned token to an attachment, or null when it is
  // not a readable, in-budget, real image. Every failure mode degrades
  // to "leave it as text" - this feature must never block a turn.
  const resolveToken = async (
    token: string,
    cwd: string,
    homedir: string,
    maxFileBytes: number,
    autoResize: boolean,
    raw: string,
  ): Promise<Resolved | null> => {
    const expanded = expandTilde(token, homedir);
    const abs = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);

    let size: number;
    try {
      const info = await stat(abs);
      if (!info.isFile()) return null;
      size = info.size;
    } catch {
      return null;
    }
    if (size === 0 || size > maxFileBytes) return null;

    let bytes: Buffer;
    try {
      bytes = await readFile(abs);
    } catch {
      return null;
    }

    const mimeType = sniffImageMime(bytes.subarray(0, SNIFF_BYTES));
    if (!mimeType) return null;

    const name = basename(abs);
    if (autoResize) {
      const resized = await resizeImage(bytes, mimeType);
      if (!resized) return null; // couldn't get under the inline size limit
      return {
        image: { type: 'image', mimeType: resized.mimeType, data: resized.data },
        ref: { raw, name, note: formatDimensionNote(resized) },
      };
    }
    return {
      image: { type: 'image', mimeType, data: bytes.toString('base64') },
      ref: { raw, name },
    };
  };

  pi.on('input', async (event, ctx: ExtensionContext) => {
    // Only act on real text input. (Already-attached images, e.g. from a
    // CLI @file or another extension, flow through untouched.)
    if (!event.text || event.text.trim().length === 0) return undefined;

    // Text-only model: don't bother reading or attaching - the path stays
    // as typed so the model at least sees the reference.
    if (!modelAcceptsImages(ctx.model?.input)) {
      if (debug && ctx.hasUI) ctx.ui.notify('image-ref: model has no image input; skipped', 'info');
      return undefined;
    }

    const tokens = extractPathTokens(event.text);
    if (tokens.length === 0) return undefined;

    const config = loadImageRefConfig(ctx.cwd);
    const homedir = process.env.HOME ?? process.env.USERPROFILE ?? '';

    const resolved: Resolved[] = [];
    for (const token of tokens) {
      if (resolved.length >= config.maxImages) break;
      // oxlint-disable-next-line no-await-in-loop -- serial by design: stop reading files once the maxImages budget is hit, rather than reading every token's bytes up front
      const r = await resolveToken(token.path, ctx.cwd, homedir, config.maxFileBytes, config.autoResize, token.raw);
      if (r) resolved.push(r);
    }

    if (resolved.length === 0) return undefined;

    const images: ImageContent[] = [...(event.images ?? []), ...resolved.map((r) => r.image)];
    const text = rewriteWithRefs(
      event.text,
      resolved.map((r) => r.ref),
    );

    if (debug && ctx.hasUI) {
      const names = resolved.map((r) => r.ref.name).join(', ');
      ctx.ui.notify(`image-ref: attached ${resolved.length} image(s): ${names}`, 'info');
    }

    return { action: 'transform', text, images };
  });

  // Stack the `&`-marker file-path completion on top of the built-in
  // provider. pi clears extension autocomplete wrappers on `/reload`
  // before re-firing `session_start`, so re-registering here can't stack
  // duplicates - no `session_shutdown` teardown is needed.
  if (!completionEnabled) return;
  pi.on('session_start', (_event, ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const homedir = process.env.HOME ?? process.env.USERPROFILE ?? '';
    ctx.ui.addAutocompleteProvider((current) => createCompletionProvider(current, ctx.cwd, homedir));
  });
}
