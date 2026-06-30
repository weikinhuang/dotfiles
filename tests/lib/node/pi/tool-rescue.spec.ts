/**
 * Tests for lib/node/pi/tool-rescue.ts.
 *
 * Pure module - no pi runtime needed. The config loader is exercised against a
 * throwaway agent dir + project dir via PI_CODING_AGENT_DIR.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  coerceToolRescueLayer,
  HARD_DENY,
  loadToolRescueConfig,
  locateAny,
  locateCall,
  locateXmlCall,
  parseLeakedCall,
  resolveRescueTools,
  specFromToolInfo,
  stripCall,
  type ToolSpec,
} from '../../../../lib/node/pi/tool-rescue.ts';

const imageSpec: ToolSpec = { tool: 'generate_image', str: ['prompt', 'negative'], num: [], required: ['prompt'] };

// ──────────────────────────────────────────────────────────────────────
// specFromToolInfo
// ──────────────────────────────────────────────────────────────────────

describe('specFromToolInfo', () => {
  test('derives str/num/required from a schema', () => {
    const spec = specFromToolInfo({
      name: 'generate_image',
      parameters: {
        type: 'object',
        properties: { prompt: { type: 'string' }, seed: { type: 'integer' }, count: { type: 'number' } },
        required: ['prompt'],
      },
    });
    expect(spec).toEqual({ tool: 'generate_image', str: ['prompt'], num: ['seed', 'count'], required: ['prompt'] });
  });

  test('required is intersected with string props (drops non-scalar required)', () => {
    const spec = specFromToolInfo({
      name: 'x',
      parameters: {
        properties: { prompt: { type: 'string' }, opts: { type: 'object' } },
        required: ['prompt', 'opts'],
      },
    });
    expect(spec?.required).toEqual(['prompt']);
  });

  test('returns null without a usable object schema', () => {
    expect(specFromToolInfo({ name: 'x' })).toBeNull();
    expect(specFromToolInfo({ name: 'x', parameters: { properties: null } })).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// locators
// ──────────────────────────────────────────────────────────────────────

describe('locateCall', () => {
  test('quote- and paren-aware: parens/commas inside a string do not end the scan', () => {
    const text = 'foo generate_image(prompt="a (b), c", negative="x") bar';
    const loc = locateCall(text, 'generate_image');
    expect(loc?.inner).toBe('prompt="a (b), c", negative="x"');
  });

  test('returns null for an unbalanced call', () => {
    expect(locateCall('generate_image(prompt="a"', 'generate_image')).toBeNull();
  });
});

describe('locateXmlCall', () => {
  test('parses a self-closing tag', () => {
    const loc = locateXmlCall('text <schedule action="create" after="1h" /> more', 'schedule');
    expect(loc?.inner).toBe(' action="create" after="1h" ');
  });

  test('null for unterminated tag', () => {
    expect(locateXmlCall('<schedule action="create"', 'schedule')).toBeNull();
  });
});

describe('locateAny', () => {
  test('prefers the earliest of paren/xml', () => {
    const text = '<generate_image src="x"/> later generate_image(prompt="y")';
    expect(locateAny(text, 'generate_image')?.start).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// parseLeakedCall
// ──────────────────────────────────────────────────────────────────────

describe('parseLeakedCall', () => {
  test('extracts string args from a paren call', () => {
    const parsed = parseLeakedCall('generate_image(prompt="a sunset", negative="blurry")', imageSpec);
    expect(parsed?.args).toEqual({ prompt: 'a sunset', negative: 'blurry' });
  });

  test('extracts numeric args', () => {
    const spec: ToolSpec = { tool: 'schedule', str: ['prompt'], num: ['chance'], required: ['prompt'] };
    const parsed = parseLeakedCall('schedule(prompt="ping", chance=0.6)', spec);
    expect(parsed?.args).toEqual({ prompt: 'ping', chance: 0.6 });
  });

  test('skips a bare mention with no required arg', () => {
    expect(parseLeakedCall('we should call generate_image() now', imageSpec)).toBeNull();
  });

  test('skips when a required arg is blank', () => {
    expect(parseLeakedCall('generate_image(prompt="   ")', imageSpec)).toBeNull();
  });

  test('parses an xml-style leak', () => {
    const parsed = parseLeakedCall('<generate_image prompt="a cat" />', imageSpec);
    expect(parsed?.args).toEqual({ prompt: 'a cat' });
  });
});

// ──────────────────────────────────────────────────────────────────────
// stripCall
// ──────────────────────────────────────────────────────────────────────

describe('stripCall', () => {
  test('removes the call and collapses a now-empty code fence', () => {
    const text = 'Here you go:\n\n```tool_code\ngenerate_image(prompt="a")\n```\n\nDone.';
    const loc = locateCall(text, 'generate_image')!;
    const out = stripCall(text, loc.start, loc.end);
    expect(out).not.toContain('generate_image(');
    expect(out).not.toContain('```');
    expect(out).toContain('Here you go:');
    expect(out).toContain('Done.');
  });
});

// ──────────────────────────────────────────────────────────────────────
// resolveRescueTools (HARD-DENY safety boundary)
// ──────────────────────────────────────────────────────────────────────

describe('resolveRescueTools', () => {
  test('subtracts the hard denylist even when explicitly listed', () => {
    const { allowed, denied } = resolveRescueTools(['generate_image', 'bash', 'edit', 'schedule']);
    expect(allowed).toEqual(['generate_image', 'schedule']);
    expect(denied.sort()).toEqual(['bash', 'edit']);
  });

  test('de-duplicates and trims, preserving order', () => {
    const { allowed } = resolveRescueTools([' generate_image ', 'generate_image', '', 'schedule']);
    expect(allowed).toEqual(['generate_image', 'schedule']);
  });

  test('every denylisted tool is rejected', () => {
    for (const t of HARD_DENY) {
      expect(resolveRescueTools([t]).allowed).toEqual([]);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// config loader
// ──────────────────────────────────────────────────────────────────────

describe('coerceToolRescueLayer', () => {
  test('keeps non-empty string tools, trims', () => {
    expect(coerceToolRescueLayer({ tools: ['a', ' b ', '', 3] })).toEqual({ tools: ['a', 'b'] });
  });

  test('non-object / no tools array yields empty', () => {
    expect(coerceToolRescueLayer(null)).toEqual({});
    expect(coerceToolRescueLayer({ tools: 'x' })).toEqual({});
  });
});

describe('loadToolRescueConfig', () => {
  let agentDir: string;
  let projectDir: string;
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'tr-agent-'));
    projectDir = mkdtempSync(join(tmpdir(), 'tr-proj-'));
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  test('absent config is an empty allowlist', () => {
    expect(loadToolRescueConfig(projectDir)).toEqual({ tools: [] });
  });

  test('unions user + project tools', () => {
    writeFileSync(join(agentDir, 'tool-rescue.json'), JSON.stringify({ tools: ['generate_image'] }));
    const piDir = join(projectDir, '.pi');
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, 'tool-rescue.json'), JSON.stringify({ tools: ['schedule'] }));
    expect([...loadToolRescueConfig(projectDir).tools].sort()).toEqual(['generate_image', 'schedule']);
  });
});
