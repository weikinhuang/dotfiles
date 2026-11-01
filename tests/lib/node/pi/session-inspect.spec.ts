import { describe, expect, it } from 'vitest';

import {
  inspectSession,
  renderSessionInspection,
  type SessionInspection,
} from '../../../../lib/node/pi/session-inspect.ts';

const PII = 'PII_MARKER_7f3a';
const LEAKS = [PII, 'Jane Doe', '555-0100', '/Users/jane'];
const pii = (label: string): string => `${PII} ${label} Jane Doe 555-0100 /Users/jane/private`;
const SESSION_ID = '01a1949b-0212-7386-b1d3-e155df4a29dd';
const usage = (input: number, output = 10): Record<string, number> => ({ input, output, cacheRead: 0, cacheWrite: 0 });

/** Synthetic session: every text-bearing field holds the PII marker. */
function syntheticSession(): string[] {
  const lines: string[] = [JSON.stringify({ type: 'session', id: SESSION_ID, cwd: `/Users/${PII}/work`, version: 3 })];
  let parent: string | null = null;
  let next = 0;
  const add = (entry: Record<string, unknown>, id = `e${++next}`): string => {
    lines.push(JSON.stringify({ id, parentId: parent, timestamp: '2026-11-01T00:00:00.000Z', ...entry }));
    parent = id;
    return id;
  };
  const custom = (customType: string, data: Record<string, unknown>): string =>
    add({ type: 'custom', customType, data });
  const assistant = (content: unknown[], input: number, stopReason = 'stop'): string =>
    add({
      type: 'message',
      message: {
        role: 'assistant',
        content,
        provider: 'llama-cpp',
        model: 'gemma4-31b-fast',
        usage: usage(input),
        stopReason,
      },
    });

  add({
    type: 'message',
    message: {
      role: 'system',
      content: '',
      sections: { base: pii('system') },
      toolsAdded: [{ name: 'read', description: pii('tool doc') }],
    },
  });
  // Turn 1: normal exchange with tools, a snapshot, and an applied recap.
  add({ type: 'message', message: { role: 'user', content: pii('user 1') } }, 'u1');
  custom('cache-reminder-snapshot', {
    anchor: 'entry:u1:0',
    specs: [
      { id: 'roleplay-depth', body: pii('depth') },
      { id: `${PII} spec`, body: pii('bad spec') },
    ],
    placements: [{ anchor: 'entry:u1:0', before: true, text: pii('placement') }],
  });
  assistant(
    [
      { type: 'text', text: pii('reply') },
      { type: 'thinking', thinking: pii('thought') },
      { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: pii('arg') } },
      { type: 'toolCall', id: 'c2', name: `${PII} tool`, arguments: {} },
    ],
    1000,
    'toolUse',
  );
  add({
    type: 'message',
    message: {
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'read',
      content: [{ type: 'text', text: pii('result') }],
    },
  });
  add({ type: 'custom_message', customType: 'scheduled-prompt', content: pii('scheduled'), display: true });
  custom('roleplay-context-recap', {
    cast: `${PII}-cast`,
    mode: 'sync',
    ok: true,
    applied: true,
    coveredFrom: 0,
    coveredTo: 2,
    spanMessages: 2,
    recap: pii('recap'),
    candidate: pii('candidate'),
    anchor: 'entry:u1:0',
  });
  custom('roleplay-timeline', {
    cast: `${PII}-cast`,
    version: 2,
    beats: pii('beats'),
    base: pii('base'),
    skip: pii('skip'),
  });
  custom('roleplay-capture', { cast: `${PII}-cast`, planned: true, parsed: 2, wrote: 1, skip: 'no-candidates' });
  // An abandoned sibling branch must not be analyzed.
  lines.push(
    JSON.stringify({
      id: 'abandoned',
      parentId: 'u1',
      type: 'message',
      message: { role: 'user', content: pii('fork') },
    }),
  );

  // Turn 2: legacy checkpoint, larger request.
  add({ type: 'message', message: { role: 'user', content: pii('user 2') } }, 'u2');
  assistant([{ type: 'text', text: pii('reply 2') }], 40000);
  custom('roleplay-context-window-state', {
    version: 1,
    cast: `${PII}-cast`,
    charsPerToken: 4,
    floorAnchor: pii('anchor'),
  });

  // Turn 3: the turn-13 signature, an uncovered drop to the latest turn.
  add({ type: 'message', message: { role: 'user', content: pii('user 3') } }, 'u3');
  custom('roleplay-context-window-debug', {
    messagesIn: 15,
    messagesOut: 1,
    natural: 0,
    committedCutoff: 0,
    recapCutoff: 0,
    floorCutoff: 14,
    dropCutoff: 14,
    recapChars: 0,
  });
  custom('roleplay-context-recap', {
    cast: `${PII}-cast`,
    mode: 'budget',
    ok: false,
    applied: false,
    coveredFrom: 2,
    coveredTo: 6,
  });
  custom('roleplay-context-window-state', {
    version: 2,
    cast: `${PII}-other-cast`,
    charsPerToken: 1.88,
    floorAnchor: 'entry:u3:0',
    projectedFloorAnchor: 'entry:u3:0',
  });
  assistant([{ type: 'text', text: pii('reply 3') }], 9000);
  assistant([], 9000, 'error');

  // Turn 4: compaction explains a shrink; assorted entries with private text.
  add({ type: 'message', message: { role: 'user', content: pii('user 4') } }, 'u4');
  add({ type: 'compaction', summary: pii('compaction'), firstKeptEntryId: 'u1', tokensBefore: 50000 });
  add({ type: 'branch_summary', fromId: 'u2', summary: pii('branch') });
  add({ type: 'label', targetId: 'u1', label: pii('label') });
  add({ type: 'session_info', name: pii('title') });
  add({ type: 'model_change', provider: 'llama-cpp', modelId: 'gemma4-31b-fast' });
  custom(`${PII} type`, { secret: pii('unknown data') });
  assistant([{ type: 'text', text: pii('reply 4') }], 3000);
  lines.push(`{"broken": "${pii('malformed')}`);
  return lines;
}

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      strings(item, out);
    }
  }
  return out;
}

describe('session-inspect', () => {
  const report: SessionInspection = inspectSession(syntheticSession());
  const anonymous = inspectSession(syntheticSession(), { anonymizeIds: true });

  it('never copies session text into the report or any rendering', () => {
    const outputs = [report, anonymous].flatMap((candidate) => [
      JSON.stringify(candidate),
      renderSessionInspection(candidate),
      renderSessionInspection(candidate, { turns: true, recaps: true, snapshots: true }),
    ]);
    for (const output of outputs) for (const leak of LEAKS) expect(output).not.toContain(leak);
  });

  it('emits only identifier-safe strings', () => {
    for (const value of strings(report)) expect(value).toMatch(/^[A-Za-z0-9 ._:;/@+(),%=<>'-]*$/);
  });

  it('summarizes the active branch, excluding abandoned siblings and malformed lines', () => {
    expect(report.sessionId).toBe(SESSION_ID);
    expect(report.file).toMatchObject({ malformedLines: 1, branches: 2, branchCycle: false });
    expect(report.totals).toMatchObject({
      userTurns: 4,
      toolCalls: 2,
      toolResults: 1,
      customMessages: 1,
      compactions: 1,
      branchSummaries: 1,
      modelChanges: 1,
      recaps: 2,
      appliedRecaps: 1,
      checkpoints: 2,
      windowDebug: 1,
      snapshots: 1,
    });
    expect(report.turns.map((row) => row.turn)).toEqual([1, 2, 3, 4]);
    expect(report.turns[0]).toMatchObject({ toolCalls: 2, toolResults: 1, promptTokens: 1000, customMessages: 1 });
    expect(report.turns[0].userChars).toBe(pii('user 1').length);
    expect(report.turns[0].thinkingChars).toBe(pii('thought').length);
  });

  it('keeps valid identifiers and redacts invalid ones', () => {
    expect(report.tools.map((tool) => tool.name).sort()).toEqual(['read', 'tool-redacted']);
    expect(report.models).toEqual([{ provider: 'llama-cpp', model: 'gemma4-31b-fast', responses: 5 }]);
    expect(report.customTypes.map((entry) => entry.type)).toContain('custom-redacted');
    expect(report.snapshots[0].specs.map((spec) => spec.id)).toEqual(['roleplay-depth', 'spec-redacted']);
    // Cast names are user-chosen and always replaced by ordinals.
    expect(report.recaps.map((recap) => recap.cast)).toEqual(['cast-1', 'cast-1']);
    expect(report.checkpoints.map((checkpoint) => checkpoint.cast)).toEqual(['cast-1', 'cast-2']);
    expect(report.audits.map((audit) => audit.skip)).toEqual(['other', 'no-candidates']);
  });

  it('anonymizes every identifier on request', () => {
    expect(anonymous.tools.map((tool) => tool.name).sort()).toEqual(['tool-1', 'tool-2']);
    expect(anonymous.models).toEqual([{ provider: 'provider-1', model: 'model-1', responses: 5 }]);
    expect(anonymous.snapshots[0].specs.map((spec) => spec.id)).toEqual(['spec-1', 'spec-2']);
  });

  it('resolves stable anchors to turns', () => {
    expect(report.recaps[0]).toMatchObject({ turn: 1, anchorTurn: 1, coveredTo: 2, recapChars: pii('recap').length });
    expect(report.checkpoints[1]).toMatchObject({ turn: 3, floorTurn: 3, projectedFloorTurn: 3 });
    expect(report.checkpoints[0]).toMatchObject({ version: 1, floorAnchor: true, floorTurn: null });
    expect(report.snapshots[0]).toMatchObject({ turn: 1, anchorTurn: 1, placements: 1 });
    expect(report.compactionRows).toEqual([
      { turn: 4, summaryChars: pii('compaction').length, tokensBefore: 50000, firstKeptTurn: 1 },
    ]);
  });

  it('flags the context-loss signatures with turn numbers', () => {
    const found = report.findings.map((finding) => `${finding.code}@${finding.turn ?? '-'}`);
    expect(found).toEqual(
      expect.arrayContaining([
        'malformed-lines@-',
        'uncovered-drop@3',
        'history-collapse@3',
        'prompt-shrink@3',
        'request-error@3',
        'legacy-checkpoint@2',
        'low-calibration@3',
        'latest-turn-floor@3',
        'safety-recap-failed@3',
      ]),
    );
    // A compaction explains the turn-4 shrink.
    expect(found).not.toContain('prompt-shrink@4');
  });

  it('detects recap stalls and coverage regressions', () => {
    const lines = [JSON.stringify({ type: 'session', id: SESSION_ID })];
    let parent: string | null = null;
    const recaps: Record<string, unknown>[] = [
      { mode: 'async', applied: true, coveredTo: 8 },
      { mode: 'async', applied: true, coveredTo: 4 },
      { mode: 'async', applied: false },
      { mode: 'async', applied: false },
      { mode: 'async', applied: false },
    ];
    recaps.forEach((data, index) => {
      const id = `r${index}`;
      lines.push(JSON.stringify({ id, parentId: parent, type: 'custom', customType: 'roleplay-context-recap', data }));
      parent = id;
    });
    const codes = inspectSession(lines).findings.map((finding) => finding.code);
    expect(codes).toContain('coverage-regression');
    expect(codes).toContain('recap-stall');
  });

  it('renders the requested tables', () => {
    const text = renderSessionInspection(report, { turns: true, recaps: true, snapshots: true });
    expect(text).toContain('per turn');
    expect(text).toContain('recaps:');
    expect(text).toContain('window checkpoints:');
    expect(text).toContain('compactions:');
    expect(text).toContain('roleplay-depth=');
    expect(renderSessionInspection(report)).not.toContain('per turn');
  });

  it('reports an empty or non-session input without throwing', () => {
    const empty = inspectSession(['', 'not json', '[1,2]']);
    expect(empty.file).toMatchObject({ records: 0, malformedLines: 2 });
    expect(empty.turns).toEqual([]);
    expect(renderSessionInspection(empty)).toContain('turns 0');
  });
});
