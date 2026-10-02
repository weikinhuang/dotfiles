#!/usr/bin/env node
// Offline cache sidecar inspection. No provider SDK, pricing lookup, or network.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cacheTraceSidecarPath } from '../pi/cache-trace-config.ts';
import {
  diffTraceRequests,
  parseCacheTraceJsonl,
  renderCacheTraceSummary,
  selectTraceRequest,
  selectTraceRequests,
  traceSnapshotText,
} from '../pi/cache-trace-reader.ts';

export const CACHE_TRACE_HELP = `Usage: ai-cache-trace <sidecar-or-session.jsonl> [options]

Default: hash-only summary, including system/tool changes and cache usage.
  --json             JSON summary (never includes raw snapshots by default)
  --run ID           Select a run ID or unique prefix (reloads create new runs)
  --diff             System text diff; defaults to the last two requests
  --from N --to N    Compare specific requests (implies --diff)
  --tools            Diff tool definitions instead of system text
  --show-system N    Print the system snapshot for a specific request
  -h, --help         Show help

Value options accept --flag=value. Raw display requires captured text.
This command is local-only; no provider calls or pricing requests are made.`;

function positive(value: string, flag: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${flag} requires a positive integer`);
  return number;
}

function main(argv: string[]): void {
  let path: string | undefined;
  let run: string | undefined;
  let from: number | undefined;
  let to: number | undefined;
  let show: number | undefined;
  let diff = false;
  let tools = false;
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const equals = arg.indexOf('=');
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    if (arg === '-h' || arg === '--help') {
      console.log(CACHE_TRACE_HELP);
      return;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--diff') {
      diff = true;
      continue;
    }
    if (arg === '--tools') {
      tools = true;
      diff = true;
      continue;
    }
    if (['--run', '--from', '--to', '--show-system'].includes(flag)) {
      const value = equals >= 0 ? arg.slice(equals + 1) : argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
      if (flag === '--run') run = value;
      else if (flag === '--from') from = positive(value, flag);
      else if (flag === '--to') to = positive(value, flag);
      else show = positive(value, flag);
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown argument: ${arg}`);
    if (path !== undefined) throw new Error('only one input path is supported');
    path = resolve(arg);
  }
  if (!path) throw new Error('a trace sidecar or session file is required; use --help');
  if ((from === undefined) !== (to === undefined)) throw new Error('--from and --to must be supplied together');
  if (show !== undefined && (diff || from !== undefined || tools))
    throw new Error('--show-system cannot be combined with diff options');
  // Session headers are small, but avoid confusing custom-named explicit trace files with sessions.
  let input = readFileSync(path, 'utf8');
  const first: unknown = (() => {
    try {
      return JSON.parse(input.split('\n')[0]) as unknown;
    } catch {
      return null;
    }
  })();
  if (first && typeof first === 'object' && (first as { type?: unknown }).type === 'session') {
    path = cacheTraceSidecarPath(path);
    if (!existsSync(path)) throw new Error(`cache sidecar not found: ${path}`);
    input = readFileSync(path, 'utf8');
  }
  const trace = parseCacheTraceJsonl(input);
  const rows = selectTraceRequests(trace, run);
  let output: string | undefined;
  if (show !== undefined) output = traceSnapshotText(trace, selectTraceRequest(trace, show, run), 'system');
  else if (diff || from !== undefined) {
    const runs = new Set(rows.map((request) => request.runId));
    if (runs.size !== 1) throw new Error('text diffs need one run; use --run');
    const start = from ?? rows.at(-2)?.sequence;
    const end = to ?? rows.at(-1)?.sequence;
    if (start === undefined || end === undefined) throw new Error('text diffs need two requests');
    output = diffTraceRequests(
      trace,
      selectTraceRequest(trace, start, run),
      selectTraceRequest(trace, end, run),
      tools ? 'tools' : 'system',
    );
  }
  if (json)
    console.log(
      JSON.stringify(
        output === undefined ? { requests: rows, warnings: trace.warnings } : { output, warnings: trace.warnings },
        null,
        2,
      ),
    );
  else console.log(output ?? renderCacheTraceSummary(rows, trace.warnings));
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`ai-cache-trace: ${error instanceof Error ? error.message : 'inspection failed'}`);
  process.exitCode = 1;
}
