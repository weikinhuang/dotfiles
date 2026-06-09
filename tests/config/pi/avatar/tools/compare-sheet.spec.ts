/**
 * Tests for config/pi/avatar/tools/compare-sheet.ts pure HTML builder.
 *
 * Pure module - no disk or network needed.
 */

import { describe, expect, test } from 'vitest';

import {
  buildCompareHtml,
  type CompareData,
  type CompareRow,
} from '../../../../../config/pi/avatar/tools/compare-sheet.ts';

function row(over: Partial<CompareRow> = {}): CompareRow {
  return {
    group: 'activities',
    state: 'hi',
    frame: 0,
    desc: 'waving hello',
    cells: ['data:image/png;base64,AAAA', ''],
    ...over,
  };
}

function data(over: Partial<CompareData> = {}): CompareData {
  return {
    title: 'avatar compare - avatar-ref/gen',
    models: ['anima', 'kontext'],
    rows: [row()],
    ...over,
  };
}

describe('buildCompareHtml', () => {
  test('emits one header column per model', () => {
    const html = buildCompareHtml(data());
    expect(html).toContain('<th>anima</th>');
    expect(html).toContain('<th>kontext</th>');
    expect(html).toContain('<th class="corner">state</th>');
  });

  test('renders a row label with state and frame index', () => {
    const html = buildCompareHtml(data({ rows: [row({ state: 'idle', frame: 1, desc: 'blink' })] }));
    expect(html).toContain('idle <span class="frame">f1</span>');
    expect(html).toContain('title="blink"');
  });

  test('renders an image cell for present sources and a placeholder for missing ones', () => {
    const html = buildCompareHtml(data());
    expect(html).toContain('<img class="shot" src="data:image/png;base64,AAAA" alt="" loading="lazy">');
    expect(html).toContain('<div class="missing">—</div>');
  });

  test('inserts a group header row only when the group changes', () => {
    const html = buildCompareHtml(
      data({
        rows: [
          row({ group: 'activities', state: 'hi', frame: 0 }),
          row({ group: 'activities', state: 'idle', frame: 0 }),
          row({ group: 'positive', state: 'happy', frame: 0 }),
        ],
      }),
    );
    const groupHeaders = html.match(/class="grouprow"/g) ?? [];
    expect(groupHeaders).toHaveLength(2);
    expect(html).toContain('<th colspan="3">activities</th>');
    expect(html).toContain('<th colspan="3">positive</th>');
  });

  test('escapes HTML in titles, models, and labels', () => {
    const html = buildCompareHtml(
      data({
        title: 'a & b',
        models: ['<m>'],
        rows: [row({ state: 'a<b', desc: 'x & y', cells: [''] })],
      }),
    );
    expect(html).toContain('<title>a &amp; b</title>');
    expect(html).toContain('<th>&lt;m&gt;</th>');
    expect(html).toContain('a&lt;b <span class="frame">f0</span>');
    expect(html).toContain('title="x &amp; y"');
  });

  test('reports cell and model counts in the header', () => {
    const html = buildCompareHtml(data({ rows: [row(), row({ state: 'idle' })] }));
    expect(html).toContain('2 cells · 2 models');
  });
});
