#!/usr/bin/env node
// Cross-harness session cost / caching doctor.
//
// Ingests a session log from any supported harness (pi, claude, codex,
// copilot, opencode), reconstructs the per-turn token/cost series, and flags cost
// explosions and prompt-caching pathologies (poisoning, TTL-expiry churn,
// cache-write-dominant spend, large-context carry) with the offending turn
// range, dollars attributed, and a remediation hint. The detection
// counterpart to the pi-only cache-breakpoint fix.
//
// Usage:
//   session-doctor.ts <session.jsonl>                 # pi / claude / codex (auto-detected)
//   session-doctor.ts --harness copilot <session-id>  # Copilot (session-state/<id>/events.jsonl)
//   session-doctor.ts --harness opencode <session-id> # opencode (SQLite DB)
//
// Pure logic lives in ./analyze/ + ./adapters/; this file is the I/O shell
// (file/DB reading, arg parsing, printing) only.
// SPDX-License-Identifier: MIT

import * as fs from 'node:fs';
import * as path from 'node:path';

import { claudeToNormalized, type ClaudeEntry } from './adapters/claude-adapter.ts';
import { codexToNormalized, type CodexEntry } from './adapters/codex-adapter.ts';
import { copilotToNormalized } from './adapters/copilot-adapter.ts';
import { opencodeToNormalized, type OpencodeSessionMeta } from './adapters/opencode-adapter.ts';
import { piToNormalized, type PiEntry } from './adapters/pi-adapter.ts';
import { detectHarness } from './analyze/detect-harness.ts';
import { DEFAULT_DETECTOR_CONFIG, runDetectors } from './analyze/detectors.ts';
import { fillTurnCosts } from './analyze/pricing-fill.ts';
import { renderReport, reportJson } from './analyze/report.ts';
import { type Harness, type NormalizedSession } from './analyze/turn-model.ts';
import {
  copilotLegacyError,
  type CopilotSessionDir,
  copilotStateDir,
  copilotStateDirMissing,
  defaultCopilotHome,
  listCopilotSessionDirs,
  loadCopilotSessionDir,
  pickCopilotSessionDir,
} from './copilot-events.ts';
import { setColorEnabled } from './format.ts';
import { readJsonlLines } from './jsonl.ts';
import { isOpencodeV2, OPENCODE_V2_REQUIRED, readOpencodeMessages, resolveOpencodeDbPath } from './opencode-db.ts';
import { expandUserPath } from './paths.ts';
import { loadPricing } from './pricing.ts';
import { collectCandidates, DEFAULT_DIRS, pickSession } from './session-locator.ts';

const HELP = `Usage: ai-cost-doctor <harness> [session-id|prefix|path] [options]
       ai-cost-doctor <session-file> [options]

Diagnose cost explosions and prompt-caching pathologies in a session log.
Detects: cache-poisoning, cache-write-dominant, ttl-expiry, large-context-carry.

Harnesses:
  pi        pi sessions (~/.pi/agent/sessions)
  claude    Claude Code sessions (~/.claude/projects)
  codex     Codex CLI sessions (~/.codex/sessions)
  copilot   GitHub Copilot CLI sessions ($COPILOT_HOME or ~/.copilot,
            session-state/<uuid>/events.jsonl)
  opencode  opencode sessions (~/.local/share/opencode, SQLite)

Session selector (second argument, optional):
  <id|prefix>          A session id or unique prefix, resolved within the
                       harness's session store (like \`ai-tool-usage <tool>
                       session <id>\`). Omit to analyze your latest session.
  <path>               An explicit path to a .jsonl session log (including a
                       Copilot session-state/<uuid>/events.jsonl) or an
                       opencode.db.

Without a harness word, a bare <session-file> path is accepted and the harness
is auto-detected from the file signature.

Options:
  --harness <name>     Force harness (alternative to the positional).
  --user-dir <dir>     Override the harness data dir.
  --json               Machine-readable JSON output.
  --turns, -t          Append a per-turn table (cacheRead/cacheWrite/cost).
  --no-color           Disable ANSI colors.
  --no-cost            Skip cost backfill for logs without precomputed cost.
  --refresh-prices     Force-refresh the cached LiteLLM pricing table.
  -h, --help           Show this help.

Examples:
  ai-cost-doctor pi                      # your latest pi session
  ai-cost-doctor pi 019f0109             # by id prefix
  ai-cost-doctor claude                  # latest claude session in this project
  ai-cost-doctor copilot dcc540db --json
  ai-cost-doctor opencode ses_2ee7 --json
  ai-cost-doctor ~/.pi/agent/sessions/<proj>/<ts>_<uuid>.jsonl`;

interface DoctorArgs {
  harness?: Harness;
  // Session id / prefix / path; empty means "latest".
  sessionRef: string;
  // Empty means "use the harness default dir".
  userDir: string;
  json: boolean;
  noColor: boolean;
  noCost: boolean;
  refreshPrices: boolean;
  turns: boolean;
}

function fail(msg: string): never {
  console.error(`session-doctor: ${msg}`);
  process.exit(1);
}

const HARNESSES = new Set<Harness>(['pi', 'claude', 'codex', 'copilot', 'opencode']);

function parseDoctorArgs(argv: string[]): DoctorArgs {
  const args: DoctorArgs = {
    sessionRef: '',
    userDir: '',
    json: false,
    noColor: false,
    noCost: false,
    refreshPrices: false,
    turns: false,
  };
  const positionals: string[] = [];

  let i = 0;
  const takeValue = (inline: string, flag: string): string => {
    if (inline) return inline;
    i++;
    const v = argv[i];
    if (v === undefined) fail(`${flag} requires a value`);
    return v;
  };

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      console.log(HELP);
      process.exit(0);
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--turns' || arg === '-t') {
      args.turns = true;
    } else if (arg === '--no-color') {
      args.noColor = true;
    } else if (arg === '--no-cost') {
      args.noCost = true;
    } else if (arg === '--refresh-prices') {
      args.refreshPrices = true;
    } else if (arg === '--harness' || arg.startsWith('--harness=')) {
      const v = takeValue(arg.startsWith('--harness=') ? arg.slice('--harness='.length) : '', '--harness');
      if (!HARNESSES.has(v as Harness)) fail(`unknown harness "${v}" (pi|claude|codex|copilot|opencode)`);
      args.harness = v as Harness;
    } else if (arg === '--user-dir' || arg.startsWith('--user-dir=')) {
      args.userDir = takeValue(arg.startsWith('--user-dir=') ? arg.slice('--user-dir='.length) : '', '--user-dir');
    } else if (arg.startsWith('-')) {
      fail(`unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
    i++;
  }

  // First positional may be a harness keyword (mirrors `ai-tool-usage <tool>`),
  // unless --harness was already given.
  if (!args.harness && positionals.length > 0 && HARNESSES.has(positionals[0] as Harness)) {
    args.harness = positionals.shift() as Harness;
  }
  if (positionals.length > 1) fail(`unexpected argument: ${positionals[1]}`);
  args.sessionRef = positionals[0] ?? '';

  if (!args.harness && !args.sessionRef) {
    console.error(HELP);
    process.exit(1);
  }
  return args;
}

function readHeadLines(filePath: string, max = 12): string[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const out: string[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

function sessionIdFromFile(filePath: string): string {
  const base = path.basename(filePath, '.jsonl');
  return base.includes('_') ? base.slice(base.lastIndexOf('_') + 1) : base;
}

function loadJsonlSession(harness: Harness, filePath: string): NormalizedSession {
  const fallbackId = sessionIdFromFile(filePath);
  if (harness === 'pi') return piToNormalized(readJsonlLines<PiEntry>(filePath), fallbackId);
  if (harness === 'claude') return claudeToNormalized(readJsonlLines<ClaudeEntry>(filePath), fallbackId);
  if (harness === 'codex') return codexToNormalized(readJsonlLines<CodexEntry>(filePath), fallbackId);
  fail(`harness ${harness} is not a JSONL format`);
}

// node:sqlite is imported lazily so the JSONL path never pays for it. An
// empty sessionId resolves to the most recently updated top-level session.
// `explicitDbPath` (an opencode.db passed as the session ref) overrides the
// --user-dir / OPENCODE_DB / default lookup.
async function loadOpencodeSession(
  sessionId: string,
  userDir: string,
  explicitDbPath?: string,
): Promise<NormalizedSession> {
  const { DatabaseSync } = await import('node:sqlite');
  const dbPath = explicitDbPath ?? resolveOpencodeDbPath(userDir);
  if (!fs.existsSync(dbPath)) fail(`opencode database not found: ${dbPath}`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  if (!isOpencodeV2(db)) fail(`${OPENCODE_V2_REQUIRED}: ${dbPath}`);

  interface Row {
    id?: string;
    time_created?: number;
    time_updated?: number;
  }
  const session = sessionId
    ? (db
        .prepare('SELECT id, time_created, time_updated FROM session_v2 WHERE id = ? OR id LIKE ?')
        .get(sessionId, `${sessionId}%`) as Row | undefined)
    : (db
        .prepare(
          'SELECT id, time_created, time_updated FROM session_v2 WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 1',
        )
        .get() as Row | undefined);
  if (!session?.id) fail(sessionId ? `opencode session not found: ${sessionId}` : 'no opencode sessions found');

  const messages = readOpencodeMessages(db, session.id);
  const meta: OpencodeSessionMeta = {
    sessionId: session.id,
    startTimeMs: session.time_created,
    endTimeMs: session.time_updated,
  };
  return opencodeToNormalized(messages, meta);
}

// Copilot logs one session.usage_record per model call in
// session-state/<uuid>/events.jsonl. Sub-agent calls (parentToolCallId set)
// are excluded so this matches the parent-session accounting used by every
// other harness adapter. An empty sessionId picks the most recently written
// log; `explicitEventsPath` (an events.jsonl passed as the session ref)
// bypasses the lookup.
function loadCopilotSession(sessionId: string, userDir: string, explicitEventsPath?: string): NormalizedSession {
  let entry: CopilotSessionDir;
  if (explicitEventsPath) {
    const dir = path.dirname(explicitEventsPath);
    entry = { id: path.basename(dir), dir, eventsPath: explicitEventsPath, mtimeMs: 0 };
  } else {
    const stateDir = copilotStateDir(expandUserPath(userDir || defaultCopilotHome()));
    if (!fs.existsSync(stateDir)) fail(copilotStateDirMissing(stateDir));
    const dirs = listCopilotSessionDirs(stateDir);
    if (sessionId) {
      const picked = pickCopilotSessionDir(dirs, sessionId);
      if (!picked.ok) {
        if (picked.error === 'ambiguous') {
          console.error(`session-doctor: ambiguous session prefix "${sessionId}", matches:`);
          for (const m of picked.matches) console.error(`  ${m}`);
          process.exit(1);
        }
        fail(`GitHub Copilot session not found: ${sessionId}`);
      }
      entry = picked.session;
    } else {
      const withEvents = dirs.filter((d) => d.eventsPath);
      if (withEvents.length === 0) fail(`no GitHub Copilot sessions found under ${stateDir}`);
      entry = withEvents.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
    }
  }

  const parsed = loadCopilotSessionDir(entry);
  if (!parsed) fail(`GitHub Copilot session ${entry.id} has no events.jsonl (never prompted)`);
  if (parsed.kind === 'legacy') fail(copilotLegacyError(parsed.sessionId, parsed.copilotVersion));
  const { session } = parsed;
  return copilotToNormalized(session.rootUsage, {
    sessionId: session.sessionId,
    startTime: session.startTime || undefined,
    endTime: session.endTime || undefined,
  });
}

async function loadSession(args: DoctorArgs): Promise<NormalizedSession> {
  const ref = args.sessionRef;

  // An explicit existing file path short-circuits everything (with or without
  // a harness word): use it directly, auto-detecting the harness if needed.
  if (ref) {
    const refPath = expandUserPath(ref);
    if (fs.existsSync(refPath) && fs.statSync(refPath).isFile()) {
      const harness = args.harness ?? detectHarness(refPath, []) ?? detectHarness(refPath, readHeadLines(refPath));
      if (!harness) fail('could not auto-detect harness; pass a harness word (pi|claude|codex|copilot|opencode)');
      if (harness === 'copilot') return loadCopilotSession('', args.userDir, refPath);
      if (harness === 'opencode') return loadOpencodeSession('', args.userDir, refPath);
      return loadJsonlSession(harness, refPath);
    }
  }

  // Otherwise we need a harness to know where to look.
  if (!args.harness) {
    fail(`file not found: ${ref} (pass a harness word, e.g. \`ai-cost-doctor pi ${ref || '<id>'}\`)`);
  }
  const harness = args.harness;

  if (harness === 'copilot') return loadCopilotSession(ref, args.userDir);
  if (harness === 'opencode') return loadOpencodeSession(ref, args.userDir);

  const userDir = args.userDir || DEFAULT_DIRS[harness];
  const candidates = collectCandidates(harness, userDir, process.cwd(), !!ref);
  const picked = pickSession(candidates, ref || undefined);
  if (!picked.ok) {
    if (picked.error === 'ambiguous') {
      console.error(`session-doctor: ambiguous session prefix "${ref}", matches:`);
      for (const m of picked.matches) console.error(`  ${m}`);
      process.exit(1);
    }
    fail(ref ? `${harness} session not found: ${ref}` : `no ${harness} sessions found under ${userDir}`);
  }
  return loadJsonlSession(harness, picked.filePath);
}

async function main(): Promise<void> {
  const args = parseDoctorArgs(process.argv.slice(2));
  setColorEnabled(!args.noColor && !args.json && process.stdout.isTTY !== false);

  const session = await loadSession(args);

  if (session.turns.length === 0) fail('no assistant turns with usage found in this session');

  if (session.costNeedsBackfill && !args.noCost) {
    const pricing = await loadPricing(args.refreshPrices);
    const res = fillTurnCosts(session, pricing);
    if (res.unpricedModels.length > 0 && !args.json) {
      console.error(`session-doctor: no pricing for ${res.unpricedModels.join(', ')}; their cost shows as $0`);
    }
  }

  const findings = runDetectors(session, DEFAULT_DETECTOR_CONFIG);

  if (args.json) {
    console.log(JSON.stringify(reportJson(session, findings, args.turns), null, 2));
  } else {
    console.log(renderReport(session, findings, { turns: args.turns }));
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
