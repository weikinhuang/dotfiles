// Shared formatting + color helpers for session-usage scripts.
// SPDX-License-Identifier: MIT

export const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  grey: '\x1b[38;5;244m',
  label: '\x1b[38;5;245m',
  session: '\x1b[38;5;033m',
  model: '\x1b[38;5;135m',
  time: '\x1b[38;5;142m',
  turns: '\x1b[38;5;179m',
  input: '\x1b[38;5;197m',
  cached: '\x1b[38;5;108m',
  output: '\x1b[38;5;214m',
  reasoning: '\x1b[38;5;173m',
  tools: '\x1b[38;5;173m',
  agents: '\x1b[38;5;109m',
  cost: '\x1b[38;5;220m',
  context: '\x1b[38;5;117m',
  header: '\x1b[38;5;244m',
  totals: '\x1b[38;5;179m',
} as const;

let useColor = true;

export function setColorEnabled(enabled: boolean): void {
  useColor = enabled;
}

export function isColorEnabled(): boolean {
  return useColor;
}

export function c(code: string, text: string): string {
  if (!useColor) return text;
  return `${code}${text}${COLORS.reset}`;
}

export function fmtSi(n: number): string {
  if (n >= 1_000_000) {
    const whole = Math.floor(n / 1_000_000);
    const frac = Math.round(((n % 1_000_000) * 100) / 1_000_000);
    if (frac === 100) return `${whole + 1}.00M`;
    return `${whole}.${String(frac).padStart(2, '0')}M`;
  }
  if (n >= 1_000) return `${Math.floor(n / 1_000)}k`;
  return String(n);
}

export function fmtDuration(secs: number): string {
  if (secs >= 3600) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return `${h}h ${String(m).padStart(2, '0')}m`;
  }
  if (secs >= 60) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}m ${String(s).padStart(2, '0')}s`;
  }
  return `${secs}s`;
}

export function fmtDate(iso: string): string {
  if (!iso) return '-';
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${min}`;
}

export function fmtDateFull(iso: string): string {
  if (!iso) return '-';
  const d = new Date(iso);
  const y = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${mm}-${dd} ${hh}:${min}`;
}

export function fmtNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export function fmtCost(cost: number): string {
  if (cost <= 0) return '$0';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export function truncate(s: string, width: number): string {
  if (s.length <= width) return s;
  return s.slice(0, Math.max(0, width - 1)) + '…';
}

export function padEndVisible(s: string, width: number): string {
  if (s.length >= width) return truncate(s, width);
  return s + ' '.repeat(width - s.length);
}
