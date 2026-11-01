/**
 * Metadata-only inspection of a pi session JSONL file, for debugging context
 * loss and roleplay window behavior without exposing conversation content.
 *
 * Privacy model: the report is built field-by-field from an allowlist. It
 * contains only numbers, booleans, null, fixed enumerations, finding text
 * composed from numbers, and identifiers (tool / model / provider / custom
 * entry / reminder spec names) that pass a strict pattern. Message bodies,
 * thinking, tool arguments and results, summaries, recap and timeline text,
 * reminder bodies, labels, paths, and cast names are never copied. Cast names
 * are user-defined, so they are always replaced by ordinals.
 *
 * No pi imports; pure over the raw JSONL lines.
 */

import { extractContentText } from './message-text.ts';
import { isRecord } from './shared/guards.ts';

export interface InspectOptions {
  /** Replace every identifier with a per-category ordinal (`tool-1`, `model-2`). */
  anonymizeIds?: boolean;
}

type IdCategory = 'tool' | 'model' | 'provider' | 'custom' | 'spec' | 'cast';

const ID_PATTERNS: Record<IdCategory, RegExp> = {
  tool: /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/,
  model: /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,99}$/,
  provider: /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,63}$/,
  custom: /^[a-z][a-z0-9_.:-]{0,63}$/,
  spec: /^[a-z][a-z0-9_.:-]{0,63}$/,
  // Never emitted verbatim; cast names are user-chosen.
  cast: /$^/,
};

const STOP_REASONS = new Set(['stop', 'length', 'toolUse', 'error', 'aborted']);
const RECAP_MODES = new Set(['sync', 'async', 'compact', 'budget']);
const AUDIT_SKIPS = new Set([
  '',
  'no-extractor',
  'no-plan',
  'extractor-null',
  'no-beats',
  'error',
  'no-session',
  'no-candidates',
  'all-duplicates',
]);

export interface WindowDebugRow {
  messagesIn: number | null;
  messagesOut: number | null;
  natural: number | null;
  committedCutoff: number | null;
  recapCutoff: number | null;
  floorCutoff: number | null;
  dropCutoff: number | null;
  recapChars: number | null;
  charsPerToken: number | null;
  estSystemTokens: number | null;
  estFullPromptTokens: number | null;
  estSentPromptTokens: number | null;
}

export interface TurnRow {
  turn: number;
  userChars: number;
  customMessages: number;
  assistantMessages: number;
  assistantChars: number;
  thinkingChars: number;
  toolCalls: number;
  toolResults: number;
  toolResultChars: number;
  /** Input + cache read + cache write of the turn's first response (the request that carried the new input). */
  promptTokens: number | null;
  peakPromptTokens: number | null;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  stopReason: string | null;
  errors: number;
  snapshotChars: number;
  recapEvents: number;
  appliedRecaps: number;
  compactions: number;
  sceneResets: number;
  castChanges: number;
  modelChanges: number;
  window: WindowDebugRow | null;
}

export interface RecapRow {
  turn: number;
  mode: string;
  cast: string | null;
  ok: boolean;
  applied: boolean;
  forced: boolean;
  trivial: boolean;
  emptySpan: boolean;
  coveredFrom: number | null;
  coveredTo: number | null;
  spanMessages: number | null;
  priorChars: number | null;
  candidateChars: number | null;
  recapChars: number | null;
  durationMs: number | null;
  anchorTurn: number | null;
}

export interface CheckpointRow {
  turn: number;
  version: number | null;
  cast: string | null;
  charsPerToken: number | null;
  floorAnchor: boolean;
  projectedFloorAnchor: boolean;
  floorTurn: number | null;
  projectedFloorTurn: number | null;
}

export interface SnapshotRow {
  turn: number;
  anchorTurn: number | null;
  specs: { id: string; chars: number }[];
  placements: number;
  placementChars: number;
}

export interface AuditRow {
  turn: number;
  kind: 'timeline' | 'capture';
  cast: string | null;
  planned: boolean;
  extractor: boolean;
  parsed: number | null;
  wrote: number | null;
  rawChars: number | null;
  skip: string;
  beatChars: number;
}

export interface CompactionRow {
  turn: number;
  summaryChars: number;
  tokensBefore: number | null;
  firstKeptTurn: number | null;
}

export interface Finding {
  severity: 'high' | 'medium' | 'info';
  code: string;
  turn: number | null;
  detail: string;
}

export interface SessionInspection {
  version: 1;
  privacy: 'metadata-only';
  sessionId: string | null;
  file: {
    records: number;
    malformedLines: number;
    branchRecords: number;
    branches: number;
    branchCycle: boolean;
  };
  totals: {
    userTurns: number;
    assistantMessages: number;
    toolCalls: number;
    toolResults: number;
    customMessages: number;
    compactions: number;
    branchSummaries: number;
    contextEdits: number;
    modelChanges: number;
    sceneResets: number;
    castChanges: number;
    snapshots: number;
    snapshotChars: number;
    recaps: number;
    appliedRecaps: number;
    checkpoints: number;
    windowDebug: number;
  };
  models: { provider: string; model: string; responses: number }[];
  tools: { name: string; calls: number; results: number; errors: number; resultChars: number }[];
  stopReasons: Record<string, number>;
  customTypes: { type: string; entries: number }[];
  turns: TurnRow[];
  recaps: RecapRow[];
  checkpoints: CheckpointRow[];
  snapshots: SnapshotRow[];
  audits: AuditRow[];
  compactionRows: CompactionRow[];
  findings: Finding[];
}

type Entry = Record<string, unknown>;

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function len(value: unknown): number {
  return typeof value === 'string' ? value.length : 0;
}

/** Size only: the extracted text is measured and immediately discarded. */
function textChars(content: unknown): number {
  return extractContentText(content, { sep: '' }).length;
}

function thinkingChars(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) if (isRecord(part) && part.type === 'thinking') total += len(part.thinking);
  return total;
}

function entryIdOfAnchor(anchor: unknown): string | null {
  if (typeof anchor !== 'string') return null;
  const match = /^entry:(.+):\d+$/.exec(anchor);
  return match ? match[1] : null;
}

function enumValue(value: unknown, allowed: ReadonlySet<string>): string {
  return typeof value === 'string' && allowed.has(value) ? value : 'other';
}

function promptOf(usage: unknown): number | null {
  if (!isRecord(usage)) return null;
  const input = num(usage.input);
  if (input === null) return null;
  return input + (num(usage.cacheRead) ?? 0) + (num(usage.cacheWrite) ?? 0);
}

function parseLines(lines: Iterable<string>): { records: Entry[]; malformed: number } {
  const records: Entry[] = [];
  let malformed = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) records.push(parsed);
      else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return { records, malformed };
}

/** Active root-to-leaf path ending at the most recently appended tree entry. */
function selectBranch(records: readonly Entry[]): { branch: Entry[]; branches: number; cycle: boolean } {
  // The header carries the session id but is not part of the entry tree.
  const tree = records.filter((entry) => entry.type !== 'session' && typeof entry.id === 'string');
  const byId = new Map<string, Entry>();
  const parents = new Set<string>();
  for (const entry of tree) {
    byId.set(entry.id as string, entry);
    if (typeof entry.parentId === 'string') parents.add(entry.parentId);
  }
  const branches = tree.filter((entry) => !parents.has(entry.id as string)).length;
  const branch: Entry[] = [];
  const seen = new Set<string>();
  let node = tree.at(-1);
  while (node && !seen.has(node.id as string)) {
    seen.add(node.id as string);
    branch.push(node);
    node = typeof node.parentId === 'string' ? byId.get(node.parentId) : undefined;
  }
  return { branch: branch.reverse(), branches, cycle: node !== undefined };
}

function emptyTurn(turn: number): TurnRow {
  return {
    turn,
    userChars: 0,
    customMessages: 0,
    assistantMessages: 0,
    assistantChars: 0,
    thinkingChars: 0,
    toolCalls: 0,
    toolResults: 0,
    toolResultChars: 0,
    promptTokens: null,
    peakPromptTokens: null,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    stopReason: null,
    errors: 0,
    snapshotChars: 0,
    recapEvents: 0,
    appliedRecaps: 0,
    compactions: 0,
    sceneResets: 0,
    castChanges: 0,
    modelChanges: 0,
    window: null,
  };
}

const WINDOW_KEYS = [
  'messagesIn',
  'messagesOut',
  'natural',
  'committedCutoff',
  'recapCutoff',
  'floorCutoff',
  'dropCutoff',
  'recapChars',
  'charsPerToken',
  'estSystemTokens',
  'estFullPromptTokens',
  'estSentPromptTokens',
] as const;

function windowRow(data: Entry): WindowDebugRow {
  const row = {} as WindowDebugRow;
  for (const key of WINDOW_KEYS) row[key] = num(data[key]);
  return row;
}

function findingsFor(report: SessionInspection): Finding[] {
  const findings: Finding[] = [];
  const add = (severity: Finding['severity'], code: string, turn: number | null, detail: string): void => {
    findings.push({ severity, code, turn, detail });
  };
  if (report.file.branchCycle)
    add('high', 'branch-cycle', null, 'parent links form a cycle; branch analysis is partial');
  if (report.file.malformedLines > 0)
    add('info', 'malformed-lines', null, `${report.file.malformedLines} unparseable line(s) skipped`);
  let previous: TurnRow | undefined;
  for (const row of report.turns) {
    const w = row.window;
    if (w?.dropCutoff !== null && w?.dropCutoff !== undefined && w.recapCutoff !== null && w.dropCutoff > w.recapCutoff)
      add(
        'high',
        'uncovered-drop',
        row.turn,
        `window dropped ${w.dropCutoff - w.recapCutoff} message(s) beyond recap coverage (drop ${w.dropCutoff}, recap ${w.recapCutoff})`,
      );
    if (w && w.messagesIn !== null && w.messagesOut !== null && w.messagesIn >= 10 && w.messagesOut <= 3)
      add('high', 'history-collapse', row.turn, `only ${w.messagesOut} of ${w.messagesIn} messages were sent`);
    const explained =
      row.compactions + row.sceneResets + row.castChanges + row.appliedRecaps + row.modelChanges > 0 ||
      (previous ? previous.compactions + previous.appliedRecaps > 0 : false);
    if (
      previous?.promptTokens &&
      row.promptTokens !== null &&
      row.promptTokens < previous.promptTokens * 0.6 &&
      !explained
    )
      add(
        'medium',
        'prompt-shrink',
        row.turn,
        `request input fell from ${previous.promptTokens} to ${row.promptTokens} tokens with no compaction, recap, scene reset, or model change`,
      );
    if (row.errors > 0) add('info', 'request-error', row.turn, `${row.errors} response(s) ended in error or abort`);
    previous = row;
  }
  for (const checkpoint of report.checkpoints) {
    if (checkpoint.version === 1)
      add('info', 'legacy-checkpoint', checkpoint.turn, 'version-1 window checkpoint (ignored by current roleplay)');
    if (checkpoint.charsPerToken !== null && checkpoint.charsPerToken < 2.5)
      add(
        'medium',
        'low-calibration',
        checkpoint.turn,
        `chars/token calibrated to ${checkpoint.charsPerToken.toFixed(2)}; budget estimates may cut too much`,
      );
    for (const [name, start] of [
      ['floor', checkpoint.floorTurn],
      ['projected floor', checkpoint.projectedFloorTurn],
    ] as const) {
      if (start !== null && checkpoint.turn >= 3 && start >= checkpoint.turn)
        add('medium', 'latest-turn-floor', checkpoint.turn, `saved ${name} starts at the current turn ${start}`);
    }
  }
  let stalled = 0;
  let covered: number | null = null;
  for (const recap of report.recaps) {
    if (recap.mode === 'budget' && !recap.applied && !recap.trivial)
      add('high', 'safety-recap-failed', recap.turn, 'a token-pressure safety recap was rejected or failed');
    stalled = recap.applied || recap.trivial ? 0 : stalled + 1;
    if (stalled === 3) add('medium', 'recap-stall', recap.turn, 'three consecutive recap rolls were not applied');
    if (recap.applied && recap.coveredTo !== null) {
      if (covered !== null && recap.coveredTo < covered && recap.mode !== 'compact')
        add(
          'medium',
          'coverage-regression',
          recap.turn,
          `recap coverage moved back from ${covered} to ${recap.coveredTo}`,
        );
      covered = recap.coveredTo;
    }
  }
  return findings;
}

/** Inspect raw session JSONL lines. The returned report never contains conversation text. */
export function inspectSession(lines: Iterable<string>, options: InspectOptions = {}): SessionInspection {
  const { records, malformed } = parseLines(lines);
  const ordinals = new Map<string, string>();
  const counters = new Map<IdCategory, number>();
  const ident = (category: IdCategory, value: unknown): string => {
    if (typeof value !== 'string' || !value) return `${category}-unknown`;
    if (!options.anonymizeIds && ID_PATTERNS[category].test(value)) return value;
    if (!options.anonymizeIds && category !== 'cast') return `${category}-redacted`;
    const key = `${category}\u0000${value}`;
    let label = ordinals.get(key);
    if (!label) {
      const next = (counters.get(category) ?? 0) + 1;
      counters.set(category, next);
      label = `${category}-${next}`;
      ordinals.set(key, label);
    }
    return label;
  };
  const castOf = (data: Entry): string | null => (typeof data.cast === 'string' ? ident('cast', data.cast) : null);

  const header = records.find((record) => record.type === 'session');
  const sessionId = typeof header?.id === 'string' && /^[0-9a-f][0-9a-f-]{7,63}$/i.test(header.id) ? header.id : null;
  const { branch, branches, cycle } = selectBranch(records);

  const turns: TurnRow[] = [emptyTurn(0)];
  const turnOf = new Map<string, number>();
  const models = new Map<string, { provider: string; model: string; responses: number }>();
  const tools = new Map<
    string,
    { name: string; calls: number; results: number; errors: number; resultChars: number }
  >();
  const stopReasons: Record<string, number> = {};
  const customTypes = new Map<string, number>();
  const recaps: RecapRow[] = [];
  const recapAnchors: (string | null)[] = [];
  const checkpoints: CheckpointRow[] = [];
  const checkpointAnchors: [string | null, string | null][] = [];
  const snapshots: SnapshotRow[] = [];
  const snapshotAnchors: (string | null)[] = [];
  const audits: AuditRow[] = [];
  const compactionRows: CompactionRow[] = [];
  const compactionAnchors: (string | null)[] = [];
  const totals: SessionInspection['totals'] = {
    userTurns: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    customMessages: 0,
    compactions: 0,
    branchSummaries: 0,
    contextEdits: 0,
    modelChanges: 0,
    sceneResets: 0,
    castChanges: 0,
    snapshots: 0,
    snapshotChars: 0,
    recaps: 0,
    appliedRecaps: 0,
    checkpoints: 0,
    windowDebug: 0,
  };
  const toolEntry = (
    name: string,
  ): { name: string; calls: number; results: number; errors: number; resultChars: number } => {
    let tool = tools.get(name);
    if (!tool) {
      tool = { name, calls: 0, results: 0, errors: 0, resultChars: 0 };
      tools.set(name, tool);
    }
    return tool;
  };

  for (const entry of branch) {
    let row = turns.at(-1)!;
    if (entry.type === 'message' && isRecord(entry.message)) {
      const message = entry.message;
      if (message.role === 'user') {
        totals.userTurns += 1;
        row = emptyTurn(totals.userTurns);
        turns.push(row);
        row.userChars = textChars(message.content);
      } else if (message.role === 'assistant') {
        totals.assistantMessages += 1;
        row.assistantMessages += 1;
        row.assistantChars += textChars(message.content);
        row.thinkingChars += thinkingChars(message.content);
        const prompt = promptOf(message.usage);
        if (prompt !== null) {
          row.promptTokens ??= prompt;
          row.peakPromptTokens = Math.max(row.peakPromptTokens ?? 0, prompt);
        }
        if (isRecord(message.usage)) {
          row.outputTokens += num(message.usage.output) ?? 0;
          row.cacheReadTokens += num(message.usage.cacheRead) ?? 0;
          row.cacheWriteTokens += num(message.usage.cacheWrite) ?? 0;
        }
        const stop = typeof message.stopReason === 'string' ? enumValue(message.stopReason, STOP_REASONS) : null;
        if (stop) {
          row.stopReason = stop;
          stopReasons[stop] = (stopReasons[stop] ?? 0) + 1;
          if (stop === 'error' || stop === 'aborted') row.errors += 1;
        }
        const provider = ident('provider', message.provider);
        const model = ident('model', message.model);
        const key = `${provider}\u0000${model}`;
        const seen = models.get(key) ?? { provider, model, responses: 0 };
        seen.responses += 1;
        models.set(key, seen);
        if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (!isRecord(part) || part.type !== 'toolCall') continue;
            totals.toolCalls += 1;
            row.toolCalls += 1;
            toolEntry(ident('tool', part.name)).calls += 1;
          }
        }
      } else if (message.role === 'toolResult') {
        totals.toolResults += 1;
        row.toolResults += 1;
        const chars = textChars(message.content);
        row.toolResultChars += chars;
        const tool = toolEntry(ident('tool', message.toolName));
        tool.results += 1;
        tool.resultChars += chars;
        if (message.isError === true) tool.errors += 1;
      }
    } else if (entry.type === 'custom_message') {
      totals.customMessages += 1;
      row.customMessages += 1;
      const type = ident('custom', entry.customType);
      customTypes.set(type, (customTypes.get(type) ?? 0) + 1);
    } else if (entry.type === 'compaction') {
      totals.compactions += 1;
      row.compactions += 1;
      compactionRows.push({
        turn: row.turn,
        summaryChars: len(entry.summary),
        tokensBefore: num(entry.tokensBefore),
        firstKeptTurn: null,
      });
      compactionAnchors.push(typeof entry.firstKeptEntryId === 'string' ? entry.firstKeptEntryId : null);
    } else if (entry.type === 'branch_summary') {
      totals.branchSummaries += 1;
    } else if (entry.type === 'context_edit') {
      totals.contextEdits += 1;
    } else if (entry.type === 'model_change') {
      totals.modelChanges += 1;
      row.modelChanges += 1;
    } else if (entry.type === 'custom') {
      const type = ident('custom', entry.customType);
      customTypes.set(type, (customTypes.get(type) ?? 0) + 1);
      const data = isRecord(entry.data) ? entry.data : {};
      switch (entry.customType) {
        case 'cache-reminder-snapshot': {
          const specs = (Array.isArray(data.specs) ? data.specs : [])
            .filter(isRecord)
            .map((spec) => ({ id: ident('spec', spec.id), chars: len(spec.body) }));
          const placements = (Array.isArray(data.placements) ? data.placements : []).filter(isRecord);
          const placementChars = placements.reduce((sum, placement) => sum + len(placement.text), 0);
          const chars = specs.reduce((sum, spec) => sum + spec.chars, 0) + placementChars;
          totals.snapshots += 1;
          totals.snapshotChars += chars;
          row.snapshotChars += chars;
          snapshots.push({ turn: row.turn, anchorTurn: null, specs, placements: placements.length, placementChars });
          snapshotAnchors.push(entryIdOfAnchor(data.anchor));
          break;
        }
        case 'roleplay-context-recap':
        case 'rp-context-recap': {
          const applied = data.applied === true || data.forced === true;
          totals.recaps += 1;
          row.recapEvents += 1;
          if (applied) {
            totals.appliedRecaps += 1;
            row.appliedRecaps += 1;
          }
          recaps.push({
            turn: row.turn,
            mode: enumValue(data.mode, RECAP_MODES),
            cast: castOf(data),
            ok: data.ok === true,
            applied,
            forced: data.forced === true,
            trivial: data.trivial === true,
            emptySpan: data.emptySpan === true,
            coveredFrom: num(data.coveredFrom),
            coveredTo: num(data.coveredTo),
            spanMessages: num(data.spanMessages),
            priorChars: num(data.priorChars),
            candidateChars:
              num(data.candidateChars) ?? (typeof data.candidate === 'string' ? data.candidate.length : null),
            recapChars: num(data.recapChars) ?? (typeof data.recap === 'string' ? data.recap.length : null),
            durationMs: num(data.durationMs),
            anchorTurn: null,
          });
          recapAnchors.push(entryIdOfAnchor(data.anchor));
          break;
        }
        case 'roleplay-context-window-state': {
          totals.checkpoints += 1;
          checkpoints.push({
            turn: row.turn,
            version: num(data.version),
            cast: castOf(data),
            charsPerToken: num(data.charsPerToken),
            floorAnchor: typeof data.floorAnchor === 'string',
            projectedFloorAnchor: typeof data.projectedFloorAnchor === 'string',
            floorTurn: null,
            projectedFloorTurn: null,
          });
          checkpointAnchors.push([entryIdOfAnchor(data.floorAnchor), entryIdOfAnchor(data.projectedFloorAnchor)]);
          break;
        }
        case 'roleplay-context-window-debug':
          totals.windowDebug += 1;
          row.window = windowRow(data);
          break;
        case 'roleplay-newscene':
          totals.sceneResets += 1;
          row.sceneResets += 1;
          break;
        case 'roleplay-cast-change':
          totals.castChanges += 1;
          row.castChanges += 1;
          break;
        case 'roleplay-timeline':
        case 'roleplay-capture':
          audits.push({
            turn: row.turn,
            kind: entry.customType === 'roleplay-timeline' ? 'timeline' : 'capture',
            cast: castOf(data),
            planned: data.planned === true,
            extractor: data.extractor === true,
            parsed: num(data.parsed),
            wrote: num(data.wrote),
            rawChars: num(data.rawChars),
            skip: enumValue(data.skip ?? '', AUDIT_SKIPS),
            beatChars: len(data.beats) + len(data.timeline),
          });
          break;
        default:
          break;
      }
    }
    if (typeof entry.id === 'string') turnOf.set(entry.id, row.turn);
  }

  const resolve = (id: string | null): number | null => (id === null ? null : (turnOf.get(id) ?? null));
  recaps.forEach((recap, index) => {
    recap.anchorTurn = resolve(recapAnchors[index]);
  });
  checkpoints.forEach((checkpoint, index) => {
    checkpoint.floorTurn = resolve(checkpointAnchors[index][0]);
    checkpoint.projectedFloorTurn = resolve(checkpointAnchors[index][1]);
  });
  snapshots.forEach((snapshot, index) => {
    snapshot.anchorTurn = resolve(snapshotAnchors[index]);
  });
  compactionRows.forEach((compaction, index) => {
    compaction.firstKeptTurn = resolve(compactionAnchors[index]);
  });

  const report: SessionInspection = {
    version: 1,
    privacy: 'metadata-only',
    sessionId,
    file: {
      records: records.length,
      malformedLines: malformed,
      branchRecords: branch.length,
      branches,
      branchCycle: cycle,
    },
    totals,
    models: [...models.values()],
    tools: [...tools.values()].sort((a, b) => b.calls + b.results - (a.calls + a.results)),
    stopReasons,
    customTypes: [...customTypes].map(([type, entries]) => ({ type, entries })).sort((a, b) => b.entries - a.entries),
    // Drop the pre-input bucket when nothing happened before the first user turn.
    turns: turns.filter(
      (row) => row.turn > 0 || row.assistantMessages + row.snapshotChars + row.recapEvents + row.compactions > 0,
    ),
    recaps,
    checkpoints,
    snapshots,
    audits,
    compactionRows,
    findings: [],
  };
  report.findings = findingsFor(report);
  return report;
}

function table(headers: readonly string[], rows: readonly (readonly (string | number | null)[])[]): string {
  const cells = [headers, ...rows.map((row) => row.map((cell) => (cell === null ? '-' : String(cell))))];
  const widths = headers.map((_, column) => Math.max(...cells.map((row) => row[column].length)));
  return cells.map((row) => row.map((cell, column) => cell.padStart(widths[column])).join('  ')).join('\n');
}

export interface RenderOptions {
  turns?: boolean;
  recaps?: boolean;
  snapshots?: boolean;
}

/** Human-readable rendering of a report; it prints only what the report already contains. */
export function renderSessionInspection(report: SessionInspection, options: RenderOptions = {}): string {
  const t = report.totals;
  const out: string[] = [
    'pi session inspection (metadata only: no message, recap, reminder, or tool text)',
    `session ${report.sessionId ?? '(unknown)'} | records ${report.file.records} | active branch ${report.file.branchRecords} | branches ${report.file.branches} | malformed ${report.file.malformedLines}`,
    `turns ${t.userTurns} | responses ${t.assistantMessages} | tool calls ${t.toolCalls} | custom messages ${t.customMessages} | compactions ${t.compactions} | model changes ${t.modelChanges}`,
    `roleplay: recaps ${t.recaps} (applied ${t.appliedRecaps}) | checkpoints ${t.checkpoints} | window debug ${t.windowDebug} | scene resets ${t.sceneResets} | cast changes ${t.castChanges}`,
    `reminder snapshots ${t.snapshots} (${t.snapshotChars} chars stored)`,
  ];
  if (report.models.length > 0)
    out.push(`models: ${report.models.map((m) => `${m.provider}/${m.model} x${m.responses}`).join(', ')}`);
  if (report.tools.length > 0)
    out.push(`tools: ${report.tools.map((tool) => `${tool.name} x${tool.calls}`).join(', ')}`);
  if (report.customTypes.length > 0)
    out.push(`custom entries: ${report.customTypes.map((c) => `${c.type} x${c.entries}`).join(', ')}`);
  out.push('', 'findings:');
  if (report.findings.length === 0) out.push('  none (heuristics only; check the per-turn table when in doubt)');
  for (const finding of report.findings)
    out.push(
      `  ${finding.severity.toUpperCase().padEnd(6)} ${finding.turn === null ? '' : `turn ${finding.turn} `}${finding.code}: ${finding.detail}`,
    );
  if (options.turns) {
    out.push(
      '',
      'per turn (prompt = first response input+cache tokens; win = roleplay window debug, when enabled):',
      table(
        [
          'turn',
          'user',
          'asst',
          'think',
          'tools',
          'prompt',
          'peak',
          'out',
          'stop',
          'snap',
          'recap',
          'win in',
          'out',
          'natural',
          'recap@',
          'floor',
          'drop',
        ],
        report.turns.map((row) => [
          row.turn,
          row.userChars,
          row.assistantChars,
          row.thinkingChars,
          row.toolCalls,
          row.promptTokens,
          row.peakPromptTokens,
          row.outputTokens,
          row.stopReason,
          row.snapshotChars,
          `${row.appliedRecaps}/${row.recapEvents}`,
          row.window?.messagesIn ?? null,
          row.window?.messagesOut ?? null,
          row.window?.natural ?? null,
          row.window?.recapCutoff ?? null,
          row.window?.floorCutoff ?? null,
          row.window?.dropCutoff ?? null,
        ]),
      ),
    );
  }
  if (options.recaps) {
    out.push(
      '',
      'recaps:',
      report.recaps.length === 0
        ? '  none'
        : table(
            [
              'turn',
              'mode',
              'cast',
              'applied',
              'trivial',
              'from',
              'to',
              'span',
              'prior',
              'cand',
              'recap',
              'ms',
              'anchor',
            ],
            report.recaps.map((r) => [
              r.turn,
              r.mode,
              r.cast,
              String(r.applied),
              String(r.trivial),
              r.coveredFrom,
              r.coveredTo,
              r.spanMessages,
              r.priorChars,
              r.candidateChars,
              r.recapChars,
              r.durationMs,
              r.anchorTurn,
            ]),
          ),
      '',
      'window checkpoints:',
      report.checkpoints.length === 0
        ? '  none'
        : table(
            ['turn', 'ver', 'cast', 'chars/tok', 'floor turn', 'projected turn'],
            report.checkpoints.map((c) => [
              c.turn,
              c.version,
              c.cast,
              c.charsPerToken === null ? null : c.charsPerToken.toFixed(2),
              c.floorTurn,
              c.projectedFloorTurn,
            ]),
          ),
      '',
      'timeline / capture audits:',
      report.audits.length === 0
        ? '  none'
        : table(
            ['turn', 'kind', 'cast', 'planned', 'parsed', 'wrote', 'raw', 'skip', 'beats'],
            report.audits.map((a) => [
              a.turn,
              a.kind,
              a.cast,
              String(a.planned),
              a.parsed,
              a.wrote,
              a.rawChars,
              a.skip || '-',
              a.beatChars,
            ]),
          ),
    );
    if (report.compactionRows.length > 0)
      out.push(
        '',
        'compactions:',
        table(
          ['turn', 'summary', 'tokensBefore', 'firstKeptTurn'],
          report.compactionRows.map((c) => [c.turn, c.summaryChars, c.tokensBefore, c.firstKeptTurn]),
        ),
      );
  }
  if (options.snapshots) {
    out.push(
      '',
      'reminder snapshots (chars per spec id):',
      report.snapshots.length === 0
        ? '  none'
        : report.snapshots
            .map(
              (s) =>
                `  turn ${s.turn} (anchor turn ${s.anchorTurn ?? '-'}): ${s.specs.map((spec) => `${spec.id}=${spec.chars}`).join(' ') || '(no specs)'}${s.placements > 0 ? ` placements=${s.placements}/${s.placementChars}` : ''}`,
            )
            .join('\n'),
    );
  }
  return out.join('\n');
}
