// JSONL reader for session-usage scripts.
// SPDX-License-Identifier: MIT

import * as fs from 'node:fs';

export function readJsonlLines<T = unknown>(filePath: string): T[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const results: T[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      results.push(JSON.parse(line) as T);
    } catch {
      // skip malformed lines
    }
  }
  return results;
}
