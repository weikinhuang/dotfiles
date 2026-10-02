import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { expect, test } from 'vitest';

import { createCacheTracer } from '../../../../lib/node/pi/cache-trace.ts';
import { cacheTraceSidecarPath } from '../../../../lib/node/pi/cache-trace-config.ts';

const cli = resolve('lib/node/ai-tooling/cache-trace-cli.ts');

test('actual local CLI reads session sidecars, emits safe JSON summaries, and diffs opt-in text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cache-cli-'));
  try {
    const session = join(dir, 'session.jsonl');
    writeFileSync(session, '{"type":"session","id":"fixture"}\n');
    const tracer = createCacheTracer({ level: 'system', runId: 'test' });
    const rows: unknown[] = [];
    for (const text of ['PRIVATE system before', 'PRIVATE system after']) {
      const { snapshots = [], ...record } = tracer(
        { instructions: text, messages: [{ role: 'user', content: 'PRIVATE user' }] },
        { provider: 'openai', model: 'fixture' },
      );
      rows.push(...snapshots, record);
    }
    writeFileSync(cacheTraceSidecarPath(session), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const summary = execFileSync(process.execPath, [cli, session, '--json'], { encoding: 'utf8' });
    expect(summary).not.toContain('PRIVATE');
    expect((JSON.parse(summary) as { requests: unknown[] }).requests).toHaveLength(2);
    const diff = execFileSync(process.execPath, [cli, session, '--from=1', '--to', '2'], { encoding: 'utf8' });
    expect(diff).toContain('-PRIVATE system before');
    expect(diff).not.toContain('PRIVATE user');
    const shown = execFileSync(process.execPath, [cli, session, '--show-system=2'], { encoding: 'utf8' });
    expect(shown).toContain('PRIVATE system after');
    for (const flags of [['--bad'], ['--from', '0'], ['--from=1'], ['--show-system=1', '--diff']]) {
      const failed = spawnSync(process.execPath, [cli, session, ...flags], { encoding: 'utf8' });
      expect(failed.status).toBe(1);
      expect(failed.stderr).not.toContain('PRIVATE');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
