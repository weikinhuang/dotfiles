/**
 * Append-only JSONL decision log with one-backup size rotation, in the
 * same shape as the sandbox violations log: when an append would push the
 * file past `maxBytes`, it is renamed to `<path>.1` first.
 *
 * Two record types share the file, joined by `id`:
 *
 *   - `decision`: what the model was asked about and what it answered.
 *   - `resolution`: what happened next when the gate abstained (the user
 *     allowed or denied the prompt, or the headless default applied).
 *     Pairing the two is what makes threshold tuning possible later.
 *
 * Logging is best-effort: a failed write never affects a decision.
 */

import { appendFileSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { ensureDirSync } from '../pi/atomic-write.ts';
import { byteLen } from '../pi/shared.ts';

export const DEFAULT_DECISION_LOG_MAX_BYTES = 5 * 1024 * 1024;

export interface DecisionLogAnswerSummary {
  /** Choice / score answers: the pick and the full distribution. */
  choice?: string;
  score?: number;
  confidence?: number;
  p?: Record<string, number>;
  /** Noul answers: probability of "yes". */
  noul?: number;
}

export interface DecisionRecord {
  type: 'decision';
  ts: string;
  id: string;
  harness: string;
  /** Use case, e.g. `shell`. */
  kind: string;
  /** Question set version, so records stay comparable after prompt edits. */
  questions: string;
  session?: string;
  cwd?: string;
  /** Redacted and length-capped. */
  command?: string;
  /** Parts the harness rules did not cover (redacted). */
  unresolved?: string[];
  provider?: string;
  model?: string;
  verdict: 'allow' | 'abstain';
  reason: string;
  latencyMs?: number;
  answers?: Record<string, DecisionLogAnswerSummary>;
  usage?: { inputTokens: number; outputTokens: number };
  error?: { kind: string; status?: number; message: string };
}

export interface ResolutionRecord {
  type: 'resolution';
  ts: string;
  id: string;
  /** `allow` / `deny` for a prompt; `default-*` when no UI could ask. */
  outcome: 'allow' | 'deny' | 'default-allow' | 'default-deny';
  /** Extra detail, e.g. opencode's `once` / `always` reply. */
  detail?: string;
}

export type DecisionLogRecord = DecisionRecord | ResolutionRecord;

/** Append one record; returns `false` (and swallows the error) when the write fails. */
export function appendDecisionLog(
  path: string,
  record: DecisionLogRecord,
  maxBytes: number = DEFAULT_DECISION_LOG_MAX_BYTES,
): boolean {
  try {
    ensureDirSync(dirname(path));
    const line = `${JSON.stringify(record)}\n`;
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      size = 0;
    }
    if (size > 0 && size + byteLen(line) > maxBytes) {
      try {
        renameSync(path, `${path}.1`);
      } catch {
        // keep appending to the live file rather than dropping the record
      }
    }
    appendFileSync(path, line);
    return true;
  } catch {
    return false;
  }
}
