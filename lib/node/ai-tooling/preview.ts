// Shared preview-string helper used by every session-usage adapter.
// SPDX-License-Identifier: MIT
//
// Each CLI surfaces a one-line "what was this session about?" preview so
// the list table and detail header carry enough context to distinguish
// sessions that share the same model / duration / directory. Different
// tools speak different flavours of user content (raw strings, arrays of
// TextContent blocks, XML-ish harness reminders), so the extraction logic
// lives here as a pure helper and adapters pass in pre-flattened strings.

/** Strip harness-injected envelopes (system-reminder, local-command, and */
/* the generic <tag>…</tag> wrappers extensions emit) so a bare user */
/* prompt bubbles up instead of the tool-runner's chrome. */
function stripHarnessEnvelopes(s: string): string {
  let out = s;
  // Drop `<system-reminder>…</system-reminder>` and `<local-command-…>…</…>`
  // blocks Claude Code emits around tool/system scaffolding. These are
  // multi-line so flag /s and be non-greedy.
  out = out.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ');
  out = out.replace(/<local-command-[^>]+>[\s\S]*?<\/local-command-[^>]+>/g, ' ');
  // Drop any remaining standalone XML-ish tags so the preview reads as
  // prose, not markup. We only strip the tags, not inner text.
  out = out.replace(/<\/?[a-zA-Z][^<>]{0,200}>/g, ' ');
  return out;
}

/**
 * Turn a raw user-message string into a compact single-line preview.
 *
 * Normalizes whitespace, strips harness envelopes, and truncates with a
 * trailing `…`. Returns an empty string when nothing meaningful remains
 * - callers should `if (preview) summary.preview = preview`.
 */
export function makeSessionPreview(raw: string | undefined | null, maxLen = 120): string {
  if (!raw) return '';
  let s = String(raw);
  // Trim early so a string that is purely `<system-reminder>…` bails out
  // before we start editing.
  if (!s.trim()) return '';
  if (s.startsWith('<system-reminder>') || s.startsWith('<local-command-')) {
    s = stripHarnessEnvelopes(s);
  } else {
    s = stripHarnessEnvelopes(s);
  }
  // Collapse every run of whitespace (including newlines) into a single
  // space so multi-line prompts render on one row.
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length <= maxLen) return s;
  // Soft-truncate on a word boundary inside the last 20% of the window so
  // we don't slice mid-word when a natural break is near the limit.
  const hardCut = Math.max(1, maxLen - 1);
  const windowStart = Math.max(0, hardCut - Math.floor(maxLen * 0.2));
  const spaceIdx = s.lastIndexOf(' ', hardCut);
  const cut = spaceIdx >= windowStart ? spaceIdx : hardCut;
  return `${s.slice(0, cut).trimEnd()}\u2026`;
}
