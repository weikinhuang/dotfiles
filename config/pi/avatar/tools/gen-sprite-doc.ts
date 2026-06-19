#!/usr/bin/env node
/**
 * Generate the full "paste into an image web UI" sprite-prompt document
 * (ChatGPT / GPT-image / Firefly) from the manifest, in one shot.
 *
 * Unlike `print-prompts.ts` (which streams raw sheet/cell prompts for ad-hoc
 * use), this renders a single self-contained markdown doc: a preamble that
 * explains the tiers, uploads, and workflow, the optional reference-art prompts,
 * and every sheet prompt wrapped in its own fenced code block (so a web UI's
 * copy button grabs just the prompt). Character-agnostic: pass your character
 * blurb via `--identity-file` / `--identity`.
 *
 * Node 24 runs this directly (`node gen-sprite-doc.ts`, type stripping is on).
 *
 * Usage:
 *   node gen-sprite-doc.ts --identity-file avatar-ref/identity.txt > avatar-ref/sprite-prompts.md
 *   node gen-sprite-doc.ts --identity-file avatar-ref/identity.txt --out avatar-ref/sprite-prompts.md
 *   node gen-sprite-doc.ts --identity "a cheerful red-haired sniper ..."
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { buildPrompt, normalizeIdentity, referencePrompt } from './prompt-lib.ts';
import { loadManifest } from './manifest-loader.ts';
import { type ContentManifest, manifest as defaultManifest } from './sprite-manifest.ts';

const IDENTITY_PLACEHOLDER =
  '<CHARACTER IDENTITY: describe hair, eyes, outfit, vibe; say "match the attached reference images">';

/** Per-tier one-line blurb for the preamble bullets; unknown tiers (character sets) fall back. */
const TIER_BLURBS: Record<string, string> = {
  standard: 'the everyday SFW emotes (base set).',
  suggestive: 'tasteful adult flirtation, still SFW (base set).',
  mature: 'the opt-in `mature` overlay (slice into its OWN set).',
};

/** Wrap a prompt body in a fenced code block (prompts never contain ``` so this is safe). */
function fence(text: string): string {
  return `\`\`\`text\n${text.trimEnd()}\n\`\`\``;
}

/** A sheet prompt with the internal `# sheet <name>` header stripped (the doc adds its own heading). */
function sheetBody(sheetName: string, identity: string, manifest: ContentManifest): string {
  const sheet = manifest.allSheets().find((s) => s.name === sheetName);
  if (sheet === undefined) throw new Error(`Unknown sheet "${sheetName}"`);
  return buildPrompt(sheet, manifest)
    .replace(/\{identity\}/g, identity)
    .replace(/^# sheet \S+\n\n/, '');
}

/**
 * Render the complete sprite-prompt markdown document for `identity`. Pure: no
 * filesystem or network, so it is unit-testable. `identity` is normalized here,
 * so callers can pass a raw blurb. Tiers, sheet counts, and bullets are derived
 * from `manifest`, so a device-local character manifest renders its own doc.
 */
export function buildSpriteDoc(rawIdentity: string, manifest: ContentManifest = defaultManifest): string {
  const identity = normalizeIdentity(rawIdentity);
  const sheets = manifest.allSheets();
  const tiers = manifest.TIERS;
  const hasMature = tiers.includes('mature');
  const groups = new Set<string>();
  for (const sheet of sheets) {
    for (const cell of sheet.cells) {
      if (cell !== null) groups.add(cell.group);
    }
  }
  const groupCount = groups.size;
  const cellCount = sheets.reduce((a, s) => a + s.cells.filter((c) => c !== null).length, 0);

  const out: string[] = [];
  const P = (line = ''): void => void out.push(line);

  P(`# Avatar sprite prompts for an image web UI (ChatGPT / GPT-image / Firefly)`);
  P();
  P(`Generate the full sprite set as **sheets**: each prompt below produces one **4-wide x 3-tall`);
  P(`grid** of up to 12 sprite cells on a flat green background with thin cyan cell borders. You`);
  P(`generate the sheets here; the cyan borders + green background are intentional **registration`);
  P(`guides** that get removed when the sheet is sliced into individual sprites locally.`);
  P();
  P(
    `The set is **${groupCount} emote groups packed into ${tiers.length} ${tiers.length === 1 ? 'tier' : 'tiers'} / ${sheets.length} sheets / ${cellCount} sprite cells**:`,
  );
  P();
  for (const tier of tiers) {
    const count = manifest.sheetsForTier(tier).length;
    const blurb = TIER_BLURBS[tier] ?? `character-specific emotes (slice into this character's OWN set).`;
    P(`- **${tier}** -- ${count} sheets: ${blurb}`);
  }
  P();
  P(`Every emote's frames are kept **together on one sheet** -- an emote never spills across a sheet`);
  P(`boundary -- so even though this web UI can't carry context between separate generations, all of`);
  P(`one emote's animation frames are drawn in the same image and stay consistent with each other.`);
  P();
  P(`> Do NOT ask the model to remove the borders or background, and do NOT ask for transparency.`);
  P(`> The flat green + cyan grid is what lets the slicer cut clean, perfectly-registered frames.`);
  P();
  P(`## Reference images to upload`);
  P();
  P(`Attach these to the conversation **before** the first sheet prompt, and keep them attached for`);
  P(`every sheet in that tier:`);
  P();
  P(`1. **\`canonical.png\`** -- REQUIRED, every single generation. The approved hero bust; the prompts`);
  P(`   treat the clean front-facing bust as the canonical reference. Path: \`avatar-ref/canonical.png\`.`);
  P(`2. **Bust turnaround (4 angles)** -- STRONGLY RECOMMENDED. Generate it once with the "Reference`);
  P(`   art" prompt below, save it, then attach it alongside the hero. Keeps head-turned /`);
  P(`   three-quarter expressions on-model.`);
  P(`3. **Full-body figure** -- OPTIONAL. Sprites are bust-only, so this matters least; attach it only`);
  P(`   if a pose ever shows more than head-and-shoulders.`);
  P();
  P(`The minimum that works is just \`canonical.png\`. The web UI has **no way to tag an attachment** as`);
  P(`"the hero" -- the model sees all the images you attached, so the prompts say "match the attached`);
  P(`**reference images**" collectively: every upload depicts the same character and they're mutually`);
  P(`consistent, so the model only has to match the character, not pick a winner.`);
  P();
  P(`## How to use this document`);
  P();
  P(`1. **One conversation per tier** (${tiers.map((t) => `\`${t}\``).join(', ')}). Each sheet is`);
  P(`   self-contained, but keeping a tier in one chat with the references attached holds the character`);
  P(`   steady across its sheets.`);
  P(`2. In that chat's first message, **attach the reference images** (hero + turnaround).`);
  P(`3. **Each sheet prompt is in a code block** -- use its copy button and paste one prompt per`);
  P(`   generation. Request a **wide / landscape** output (e.g. 1536x1024) so the 4x3 grid gets the`);
  P(`   most pixels per cell.`);
  if (hasMature) {
    P(`4. **Download each result** named \`<tier>.<n>.png\` exactly as the heading says (e.g.`);
    P(`   \`standard.1.png\`, \`mature.2.png\`). Keep \`mature.*\` aside for its own set; the rest are the base set.`);
  } else {
    P(`4. **Download each result** named \`<tier>.<n>.png\` exactly as the heading says (e.g.`);
    P(`   \`${tiers[0] ?? 'standard'}.1.png\`). Slice every sheet into this character's set.`);
  }
  P(`5. Bring the PNGs back to the repo; \`slice-sheets.ts\` cuts each sheet into cells (it auto-detects`);
  P(`   the 4x3 grid and keys out the green + cyan).`);
  P();
  P(`### Tips`);
  P();
  P(`- If a sheet returns the wrong cell count, merged poses, or baked-in text labels, just regenerate`);
  P(`  that one sheet -- don't try to fix it in chat. Re-using the same chat keeps it on-model.`);
  P(`- Keep the bust crop identical cell-to-cell; identical framing is what makes the multi-frame`);
  P(`  states animate cleanly.`);
  P(`- The grid reads **left-to-right, then top-to-bottom** (cell 1 = top-left, cell 12 = bottom-right).`);
  P(`  Blank cells say "leave blank - background only".`);
  P();
  P(`---`);
  P();
  P(`## Reference art (generate first / once)`);
  P();
  P(`You already have the hero (\`canonical.png\`). These two produce the optional extra references you`);
  P(`upload alongside it. Attach your original character art (or \`canonical.png\`) when generating them;`);
  P(`they use a plain gray background and are **never sliced**.`);
  P();
  P(`### turnaround (bust, 4 angles)`);
  P();
  P(fence(referencePrompt('turnaround', identity)));
  P();
  P(`### full-body figure`);
  P();
  P(fence(referencePrompt('full-body', identity)));
  P();
  P(`---`);
  P();
  P(`## Sheet prompts (paste one per generation)`);

  let lastTier = '';
  for (const sheet of sheets) {
    if (sheet.tier !== lastTier) {
      P();
      P(`## Tier: ${sheet.tier}`);
      lastTier = sheet.tier;
    }
    P();
    P(`### ${sheet.name}`);
    P();
    P(`Download as \`${sheet.name}.png\`.`);
    P();
    P(fence(sheetBody(sheet.name, identity, manifest)));
  }
  P();
  return out.join('\n');
}

interface DocOpts {
  identity: string;
  out: string;
  manifest: string;
}

function parseArgs(argv: string[]): DocOpts {
  const opts: DocOpts = { identity: IDENTITY_PLACEHOLDER, out: '', manifest: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const next = (): string => inline ?? argv[++i];
    switch (key) {
      case '-h':
      case '--help':
        process.stdout.write(
          'Usage: node gen-sprite-doc.ts [--identity-file <path>|--identity <text>] [--manifest <path>] [--out <path>]\n' +
            '  Writes the full image-web-UI sprite-prompt doc to --out (or stdout).\n' +
            '  --manifest <path>  Device-local manifest module (exports `manifest`); default: the committed set.\n',
        );
        process.exit(0);
        break;
      case '--identity':
        opts.identity = next();
        break;
      case '--identity-file':
        opts.identity = readFileSync(next(), 'utf8');
        break;
      case '--manifest':
        opts.manifest = next();
        break;
      case '--out':
        opts.out = next();
        break;
      default:
        process.stderr.write(`Unknown argument: ${arg}\n`);
        process.exit(1);
    }
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = await loadManifest(opts.manifest);
  const doc = buildSpriteDoc(opts.identity, manifest);
  if (opts.out.length > 0) {
    writeFileSync(opts.out, `${doc}\n`);
    process.stderr.write(`Wrote ${opts.out}\n`);
  } else {
    process.stdout.write(`${doc}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
