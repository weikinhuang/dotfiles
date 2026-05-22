/**
 * Tests for lib/node/pi/waveform-indicator-persona.ts.
 *
 * Pure module - the `fs` adapter is injected so we drive every test
 * with an in-memory map of `path → contents`, no temp directories.
 */

import { describe, expect, test } from 'vitest';

import {
  type PersonaFsAdapter,
  type PersonaLayerPaths,
  type FrontmatterParser,
  loadPersonaBody,
  resolvePersonaPath,
} from '../../../../lib/node/pi/waveform-indicator-persona.ts';

// ──────────────────────────────────────────────────────────────────────
// Test fixtures
// ──────────────────────────────────────────────────────────────────────

const LAYERS: PersonaLayerPaths = {
  projectDir: '/proj/.pi/personas',
  userDir: '/home/u/.pi/personas',
  shippedDir: '/repo/config/pi/personas',
};

function fsFromMap(files: Map<string, string>): PersonaFsAdapter {
  return {
    exists: (p: string) => files.has(p),
    readFile: (p: string) => files.get(p) ?? null,
  };
}

/**
 * Trivial frontmatter parser - split on the first `---` block to
 * mimic pi's `parseFrontmatter` well enough for these unit tests.
 * Returns `{ frontmatter: {}, body }` when no frontmatter present.
 */
const fakeParseFrontmatter: FrontmatterParser = (raw: string) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { frontmatter: {}, body: raw };
  const fm: Record<string, unknown> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const eq = line.indexOf(':');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (!k) continue;
    if (v === '[]') {
      fm[k] = [];
    } else if (v.startsWith('[') && v.endsWith(']')) {
      fm[k] = v
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else {
      fm[k] = v;
    }
  }
  return { frontmatter: fm, body: m[2] };
};

/** Throwing frontmatter parser - simulates pi rejecting a malformed file. */
const throwingParseFrontmatter: FrontmatterParser = () => {
  throw new Error('malformed YAML at line 3');
};

// ──────────────────────────────────────────────────────────────────────
// resolvePersonaPath
// ──────────────────────────────────────────────────────────────────────

describe('resolvePersonaPath', () => {
  test('returns null for empty name', () => {
    expect(resolvePersonaPath('', LAYERS, fsFromMap(new Map()))).toBeNull();
    expect(resolvePersonaPath('   ', LAYERS, fsFromMap(new Map()))).toBeNull();
  });

  test('layer-order resolution: project beats user beats shipped', () => {
    const files = new Map([
      ['/proj/.pi/personas/daemon-waveform.md', 'project'],
      ['/home/u/.pi/personas/daemon-waveform.md', 'user'],
      ['/repo/config/pi/personas/daemon-waveform.md', 'shipped'],
    ]);
    expect(resolvePersonaPath('daemon-waveform', LAYERS, fsFromMap(files))).toBe(
      '/proj/.pi/personas/daemon-waveform.md',
    );
  });

  test('falls through project → user when project layer missing', () => {
    const files = new Map([
      ['/home/u/.pi/personas/daemon-waveform.md', 'user'],
      ['/repo/config/pi/personas/daemon-waveform.md', 'shipped'],
    ]);
    expect(resolvePersonaPath('daemon-waveform', LAYERS, fsFromMap(files))).toBe(
      '/home/u/.pi/personas/daemon-waveform.md',
    );
  });

  test('falls through to shipped when neither project nor user carry it', () => {
    const files = new Map([['/repo/config/pi/personas/daemon-waveform.md', 'shipped']]);
    expect(resolvePersonaPath('daemon-waveform', LAYERS, fsFromMap(files))).toBe(
      '/repo/config/pi/personas/daemon-waveform.md',
    );
  });

  test('returns null when no layer has the persona', () => {
    expect(resolvePersonaPath('nonexistent', LAYERS, fsFromMap(new Map()))).toBeNull();
  });

  test('handles symlinked install paths transparently (shipped layer found by its resolved path)', () => {
    // Simulating: the dotfiles repo is installed via symlink, so
    // `extDir` resolves to the real path; layers.shippedDir reflects
    // that. The lookup itself doesn't care about symlinks - the
    // adapter does. Here we just assert the loader walks the shippedDir
    // we hand it without rewriting the path.
    const files = new Map([['/var/lib/dotfiles-real/config/pi/personas/daemon-waveform.md', 'shipped']]);
    const symlinkLayers: PersonaLayerPaths = {
      projectDir: '/proj/.pi/personas',
      userDir: '/home/u/.pi/personas',
      shippedDir: '/var/lib/dotfiles-real/config/pi/personas',
    };
    expect(resolvePersonaPath('daemon-waveform', symlinkLayers, fsFromMap(files))).toBe(
      '/var/lib/dotfiles-real/config/pi/personas/daemon-waveform.md',
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// loadPersonaBody
// ──────────────────────────────────────────────────────────────────────

const DAEMON_FILE = `---
description: Voice overlay
tools: []
---

This is the daemon body.
`;

describe('loadPersonaBody', () => {
  test('returns trimmed body on a well-formed persona file', () => {
    const path = '/proj/.pi/personas/daemon-waveform.md';
    const fs = fsFromMap(new Map([[path, DAEMON_FILE]]));
    const result = loadPersonaBody(path, fakeParseFrontmatter, fs);
    expect(result.body).toBe('This is the daemon body.');
    expect(result.source).toBe(path);
    expect(result.warnings).toHaveLength(0);
  });

  test('round-trips frontmatter + body: parser splits on the `---` block', () => {
    // The body's "round-trip" is implicit - we don't re-emit the
    // frontmatter, but the body slice should match exactly the
    // text after the second `---` (trimmed).
    const customBody = '# daemon\n\nA voice overlay with multi-line content.\n';
    const file = `---\ndescription: voice\n---\n${customBody}`;
    const path = '/proj/.pi/personas/x.md';
    const fs = fsFromMap(new Map([[path, file]]));
    const result = loadPersonaBody(path, fakeParseFrontmatter, fs);
    expect(result.body).toBe(customBody.trim());
  });

  test('missing-file fallback: unreadable path returns null + warning', () => {
    const fs = fsFromMap(new Map());
    const result = loadPersonaBody('/proj/.pi/personas/missing.md', fakeParseFrontmatter, fs);
    expect(result.body).toBeNull();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].reason).toMatch(/unreadable/);
  });

  test('malformed-persona fallback: parser threw returns null + warning', () => {
    const path = '/proj/.pi/personas/bad.md';
    const fs = fsFromMap(new Map([[path, '---\nnot: valid\n']]));
    const result = loadPersonaBody(path, throwingParseFrontmatter, fs);
    expect(result.body).toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0].reason).toMatch(/malformed YAML/);
  });

  test('missing frontmatter (no `---` block) returns null without throwing', () => {
    const path = '/proj/.pi/personas/no-fm.md';
    const fs = fsFromMap(new Map([[path, 'just plain markdown, no frontmatter\n']]));
    const result = loadPersonaBody(path, fakeParseFrontmatter, fs);
    expect(result.body).toBeNull();
  });

  test('empty body returns null + warning even when frontmatter parses cleanly', () => {
    const path = '/proj/.pi/personas/empty-body.md';
    const fs = fsFromMap(new Map([[path, '---\ndescription: voice\n---\n   \n\n']]));
    const result = loadPersonaBody(path, fakeParseFrontmatter, fs);
    expect(result.body).toBeNull();
    expect(result.warnings.some((w) => w.reason.includes('empty'))).toBe(true);
  });
});
