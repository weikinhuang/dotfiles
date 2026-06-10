/**
 * Unit tests for the image-web-UI sprite-prompt doc generator. Exercises the
 * pure `buildSpriteDoc` so the CLI's main() stays untested boilerplate.
 */
import { describe, expect, test } from 'vitest';

import { buildSpriteDoc } from '../../../../../config/pi/avatar/tools/gen-sprite-doc.ts';
import { SFW_GUARD } from '../../../../../config/pi/avatar/tools/prompt-lib.ts';
import { allSheets, sheetsForTier } from '../../../../../config/pi/avatar/tools/sprite-manifest.ts';

const IDENTITY = 'a cheerful red-haired sniper with a halo';
const DOC = buildSpriteDoc(IDENTITY);
const SHEETS = allSheets();

describe('buildSpriteDoc', () => {
  test('renders the preamble with live tier and sheet counts', () => {
    expect(DOC).toContain('# Avatar sprite prompts for an image web UI');
    expect(DOC).toContain(`/ ${SHEETS.length} sheets /`);
    expect(DOC).toContain(`**standard** -- ${sheetsForTier('standard').length} sheets`);
    expect(DOC).toContain(`**suggestive** -- ${sheetsForTier('suggestive').length} sheets`);
    expect(DOC).toContain(`**mature** -- ${sheetsForTier('mature').length} sheets`);
  });

  test('emits one heading, download line, and fenced block per sheet (plus 2 reference prompts)', () => {
    for (const sheet of SHEETS) {
      expect(DOC).toContain(`### ${sheet.name}\n`);
      expect(DOC).toContain(`Download as \`${sheet.name}.png\`.`);
    }
    // Each sheet + the turnaround + full-body reference prompts are fenced.
    const fences = DOC.split('\n').filter((l) => l === '```text' || l === '```').length;
    expect(fences).toBe((SHEETS.length + 2) * 2);
  });

  test('substitutes the identity into prompts and never leaks the placeholder', () => {
    expect(DOC).toContain(IDENTITY);
    expect(DOC).not.toContain('{identity}');
    expect(DOC).not.toContain('CHARACTER IDENTITY');
  });

  test('mature/suggestive sheets carry the SFW guard; standard sheets do not', () => {
    const matureSheets = sheetsForTier('mature');
    const standardSheets = sheetsForTier('standard');
    expect(matureSheets.length).toBeGreaterThan(0);
    expect(standardSheets.length).toBeGreaterThan(0);
    const section = (name: string): string => {
      const start = DOC.indexOf(`### ${name}\n`);
      const end = DOC.indexOf('### ', start + 1);
      return DOC.slice(start, end < 0 ? undefined : end);
    };
    expect(section(matureSheets[0].name)).toContain(SFW_GUARD);
    expect(section(standardSheets[0].name)).not.toContain(SFW_GUARD);
  });

  test('strips the internal "# sheet" header from each fenced prompt body', () => {
    expect(DOC).not.toContain('# sheet standard.1');
  });
});
