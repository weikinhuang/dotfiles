/**
 * Deep-research extension for pi — Phase 1 shell.
 *
 * Registers the `/research` slash command with three sub-forms:
 *
 *   - `/research --list`      → walk `./research/`, print a
 *                                `slug | status | wall-clock | cost`
 *                                table via `research-runs.runListCommand`.
 *   - `/research --selftest`  → run the research-core canned fixture
 *                                via `research-selftest.selftestDeepResearch`
 *                                and report the result.
 *   - `/research <question>`  → stub. Phase 2 wires up the planner +
 *                                fanout pipeline; today it just notifies
 *                                "not yet implemented (phase 2)".
 *
 * The actual command logic lives in `lib/node/pi/research-runs.ts`
 * (pure, unit-tested under `tests/config/pi/extensions/`). This file
 * is the thin pi-coupled shell: parse the raw command args, call
 * into the pure helper with an injected `notify`, done.
 *
 * Environment:
 *
 *   PI_DEEP_RESEARCH_DISABLED=1   skip the extension entirely.
 */

import { type ExtensionAPI } from '@mariozechner/pi-coding-agent';
import {
  type CommandNotify,
  type CommandNotifyLevel,
  runListCommand,
  runSelftestCommand,
} from '../../../lib/node/pi/research-runs.ts';
import { selftestDeepResearch } from '../../../lib/node/pi/research-selftest.ts';

/** Usage string shown on a bare `/research` invocation. */
const USAGE =
  'Usage:\n' +
  '  /research <question>   — run a deep-research pipeline (phase 2+)\n' +
  '  /research --list       — list runs under ./research/\n' +
  '  /research --selftest   — run the research-core self-test fixture';

export default function deepResearchExtension(pi: ExtensionAPI): void {
  if (process.env.PI_DEEP_RESEARCH_DISABLED === '1') return;

  pi.registerCommand('research', {
    description: 'Long-horizon web research (Phase 1: --list / --selftest; /research <q> lands in Phase 2).',
    handler: async (rawArgs, ctx) => {
      const args = (rawArgs ?? '').trim();
      // Split on whitespace so `/research --list foo bar` routes to
      // the list handler (the trailing args are logged and ignored)
      // rather than falling through to the Phase-2 question stub.
      // Phase 2 will add proper subcommand / flag parsing.
      const [firstToken = '', ...restTokens] = args.split(/\s+/);
      const rest = restTokens.join(' ').trim();
      const notify: CommandNotify = (message: string, level: CommandNotifyLevel) => {
        ctx.ui.notify(message, level);
      };

      if (args === '' || firstToken === '--help' || firstToken === '-h') {
        notify(USAGE, 'info');
        return;
      }

      if (firstToken === '--list') {
        if (rest) notify(`/research --list: ignoring trailing args: ${JSON.stringify(rest)}`, 'warning');
        runListCommand({ cwd: ctx.cwd, notify });
        return;
      }

      if (firstToken === '--selftest') {
        if (rest) notify(`/research --selftest: ignoring trailing args: ${JSON.stringify(rest)}`, 'warning');
        await runSelftestCommand({ cwd: ctx.cwd, selftest: selftestDeepResearch, notify });
        return;
      }

      // Any other args are treated as the research question (stub in
      // Phase 1; Phase 2 will route through planner → fanout → synth).
      notify(`/research <question>: not yet implemented (phase 2). Received: ${JSON.stringify(args)}`, 'info');
    },
  });
}
