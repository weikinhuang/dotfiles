// Shared CLI runner for session-usage tool adapters.
// SPDX-License-Identifier: MIT

import { parseArgs, type ParsedArgs } from './args.ts';
import { setColorEnabled } from './format.ts';
import { printDetailJson, printListJson, printSessionDetail, printSessionTable, sortSessions } from './output.ts';
import { expandUserPath } from './paths.ts';
import type { SessionDetail, SessionSummary } from './types.ts';

export interface SessionUsageAdapter<Ctx> {
  help: string;
  // Absolute path or `~`-prefixed path to the tool's data dir.
  defaultUserDir: string;
  // Resolves a tool-specific context from parsed args and the resolved user dir.
  resolveContext: (args: ParsedArgs, userDir: string) => Ctx;
  // Returns all sessions relevant to the current filter context (cwd/project).
  listSessions: (ctx: Ctx) => SessionSummary[];
  // Loads a full detail record for a specific session (supports prefix match).
  loadSessionDetail: (ctx: Ctx, sessionId: string) => SessionDetail;
  // Optional label shown above the session list (e.g. claude's project slug).
  listLabel?: (ctx: Ctx) => string | undefined;
  // Optional session-argument label shown in help/errors (e.g. "<uuid>").
  sessionArgLabel?: string;
}

export function runSessionUsageCli<Ctx>(adapter: SessionUsageAdapter<Ctx>): void {
  const args = parseArgs(process.argv.slice(2), {
    help: adapter.help,
    sessionArgLabel: adapter.sessionArgLabel,
  });
  setColorEnabled(!args.noColor && !args.json && process.stdout.isTTY !== false);

  const userDir = expandUserPath(args.userDir || adapter.defaultUserDir);
  const ctx = adapter.resolveContext(args, userDir);

  if (args.command === 'session') {
    const detail = adapter.loadSessionDetail(ctx, args.sessionId);
    if (args.json) {
      printDetailJson(detail);
    } else {
      printSessionDetail(detail);
    }
    return;
  }

  let sessions = adapter.listSessions(ctx);
  sessions = sortSessions(sessions, args.sort);
  if (args.limit > 0) sessions = sessions.slice(0, args.limit);

  const label = adapter.listLabel?.(ctx);
  if (args.json) {
    printListJson(sessions, label);
  } else {
    printSessionTable(sessions, label);
  }
}
