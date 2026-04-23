// JSONL reader for session-usage scripts.
// SPDX-License-Identifier: MIT

import * as fs from 'fs';

export function readJsonlLines(filePath: string): any[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const results: any[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      results.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return results;
}
