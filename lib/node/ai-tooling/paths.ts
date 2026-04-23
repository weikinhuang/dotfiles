// Path helpers for session-usage scripts.
// SPDX-License-Identifier: MIT

import * as path from 'path';

export function expandUserPath(p: string): string {
  if (p.startsWith('~')) return path.join(process.env.HOME ?? '', p.slice(1));
  return path.resolve(p);
}

export function resolveProjectPath(input: string): string {
  if (!input) return process.cwd();
  return expandUserPath(input);
}
