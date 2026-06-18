/**
 * Pure text helpers for the `tts` extension.
 *
 * Phase 1 carries over the reusable RP-mode helpers from the legacy
 * `rp-tts.ts`: {@link extractDialogue} (quoted-span extraction) and
 * {@link detectOoc} (pause/resume marker detection). Both are pure and
 * unit-tested.
 *
 * Phase 3 adds narration-mode handling: {@link extractProse} (strip code
 * fences, tool noise, `generate_image(...)`, markdown decoration, color tags,
 * raw URLs) and {@link chunkProse} (sentence/paragraph chunk splitter).
 *
 * Phase 6 adds {@link extractSegments} for "narrated roleplay": ordered
 * dialogue/narration spans so a clone voice and a narrator voice can interleave.
 *
 * No pi imports.
 */

/**
 * Extract speakable dialogue from a raw assistant reply: the concatenation of
 * its double-quoted spans (straight `"..."` and smart curly quotes), with
 * non-spoken scaffolding removed first. Returns `""` when there is no dialogue.
 *
 * Strips, in order: fenced code blocks, whole `[OOC: ...]` blocks (author-voice
 * / meta), literal `generate_image(...)` calls, `[emote:...]` tags, and color
 * tag markers (keeping their inner text). Single quotes are ignored so a
 * contraction apostrophe never breaks a run.
 */
export function extractDialogue(raw: string): string {
  if (!raw) return '';
  let t = raw;
  t = t.replace(/```[\s\S]*?```/g, ' ');
  t = t.replace(/\[OOC:[\s\S]*?\]/gi, ' ');
  t = t.replace(/\bgenerate_image\s*\([\s\S]*?\)/gi, ' ');
  t = t.replace(/\[emote:[^\]]*\]/gi, ' ');
  // Color tags: drop the markers, keep the inner text (it may be dialogue).
  t = t.replace(/\[c:[^\]]*\]/gi, '').replace(/\[\/c\]/gi, '');

  // Pull double-quoted spans. Straight quotes (group 1) OR smart quotes (group
  // 2). Single quotes are ignored so contraction apostrophes never break a run.
  const spans: string[] = [];
  const re = /"([^"]+)"|\u201c([^\u201d]+)\u201d/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const inner = (m[1] ?? m[2] ?? '').replace(/\s+/g, ' ').trim();
    if (inner) spans.push(inner);
  }
  return spans.join(' ').trim();
}

/** Detect an OOC pause/resume marker in a message; `null` if neither. Resume wins. */
export function detectOoc(text: string): 'pause' | 'resume' | null {
  if (!text) return null;
  if (/\[OOC:\s*RESUME/i.test(text)) return 'resume';
  if (/\[OOC:\s*PAUSE/i.test(text)) return 'pause';
  return null;
}

/**
 * Extract speakable prose from a raw assistant reply for narration mode.
 * Unlike {@link extractDialogue} (which keeps only quoted spans), this keeps
 * the whole reply but strips everything that should not be read aloud, then
 * flattens markdown decoration to plain words.
 *
 * Removed wholesale (never spoken): ANSI / terminal control sequences, tool +
 * agent scaffolding blocks (`<thinking>`, `<tool_call>`, `<tool_result>`,
 * `<function_call>`, `<system-reminder>`, `[TOOL CALLED]` markers), fenced code
 * blocks, `[OOC: ...]` blocks, literal `generate_image(...)` calls, `[emote:...]`
 * tags, HTML/XML tags, markdown images, table rows, bare URLs, and any leftover
 * non-printable control characters.
 *
 * Flattened (markers dropped, text kept): color tags, markdown links (keep the
 * link text), inline code backticks, emphasis (`*`/`_`/`~`), heading hashes,
 * blockquote markers, and list bullets / numbering.
 *
 * Returns `""` when nothing speakable remains.
 */
export function extractProse(raw: string): string {
  if (!raw) return '';
  let t = raw;

  // --- ANSI / terminal control sequences (ESC held in a string so no control
  //     character appears in a regex literal) ---
  const ESC = '\u001b';
  t = t.replace(new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g'), ''); // CSI (colors, cursor)
  t = t.replace(new RegExp(`${ESC}\\][\\s\\S]*?(?:\u0007|${ESC}\\\\)`, 'g'), ''); // OSC ... BEL/ST
  t = t.replace(new RegExp(`${ESC}[@-Z\\\\-_]`, 'g'), ''); // other lone ESC escapes

  // --- remove whole tool / agent scaffolding blocks (content and all) ---
  t = t.replace(/<(thinking|tool_call|tool_result|function_call|system-reminder)\b[\s\S]*?<\/\1>/gi, ' ');
  t = t.replace(/\[TOOL CALLED\]/gi, ' '); // collapse_output placeholder marker

  // --- remove non-spoken blocks ---
  t = t.replace(/```[\s\S]*?```/g, ' '); // fenced code
  t = t.replace(/~~~[\s\S]*?~~~/g, ' '); // fenced code (tilde)
  t = t.replace(/\[OOC:[\s\S]*?\]/gi, ' '); // OOC / meta blocks
  t = t.replace(/\bgenerate_image\s*\([\s\S]*?\)/gi, ' '); // literal tool call
  t = t.replace(/\[emote:[^\]]*\]/gi, ' '); // emote tags
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' '); // markdown images (drop alt + url)

  // --- flatten links: keep the visible text, drop the URL ---
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  // --- color tags: drop the markers, keep inner text ---
  t = t.replace(/\[c:[^\]]*\]/gi, '').replace(/\[\/c\]/gi, '');

  // --- strip remaining HTML/XML tags ---
  t = t.replace(/<\/?[a-z][^>]*>/gi, ' ');

  // --- drop bare URLs (left after link flattening, or standalone) ---
  t = t.replace(/\bhttps?:\/\/\S+/gi, ' ');

  // --- inline code: drop the backticks, keep the token ---
  t = t.replace(/`([^`]+)`/g, '$1');

  // --- per-line markdown decoration ---
  const lines = t.split('\n').map((line) => {
    let l = line;
    l = l.replace(/^\s{0,3}#{1,6}\s+/, ''); // ATX heading hashes
    l = l.replace(/^\s{0,3}>\s?/, ''); // blockquote marker
    l = l.replace(/^\s*[-*+]\s+/, ''); // bullet list marker
    l = l.replace(/^\s*\d+[.)]\s+/, ''); // ordered list marker
    // drop a markdown table row entirely (pipes + separator rows) - not speakable
    if (/^\s*\|.*\|\s*$/.test(l) || /^\s*\|?[\s:|-]+\|?\s*$/.test(l)) return '';
    return l;
  });
  t = lines.join('\n');

  // --- emphasis markers: drop `**` / `__` / `*` / `_` / `~~` / `~` ---
  t = t.replace(/(\*\*|__|~~|[*_~])/g, '');

  // --- strip any remaining non-printable C0/C1 control characters ---
  // oxlint-disable-next-line no-control-regex -- intentional: strip C0/C1 control bytes from spoken text
  t = t.replace(new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]', 'g'), ' ');

  // --- collapse whitespace (newlines included) into single spaces ---
  return t.replace(/\s+/g, ' ').trim();
}

/** One ordered span of a reply, tagged by how it should be voiced. */
export interface Segment {
  /** `dialogue` = inside quotes (character voice); `narration` = everything else. */
  kind: 'dialogue' | 'narration';
  /** Speakable text, already stripped + flattened, quotes removed. */
  text: string;
}

/**
 * Split a raw assistant reply into ordered {@link Segment}s for "narrated
 * roleplay": each double-quoted span becomes a `dialogue` segment (spoken in the
 * character voice) and the prose between/around quotes becomes a `narration`
 * segment (spoken in the narrator voice), preserving reading order so the two
 * voices interleave naturally.
 *
 * Reuses {@link extractProse} for stripping + markdown flattening (it preserves
 * the `"` quote characters), then walks the quote spans. Straight `"..."` and
 * smart curly quotes are both recognised; single quotes are left alone so a
 * contraction apostrophe never splits a run. Segments with no letter/number
 * (e.g. an orphaned comma left between two quotes) are dropped. Returns `[]`
 * when nothing speakable remains.
 */
export function extractSegments(raw: string): Segment[] {
  const clean = extractProse(raw);
  if (!clean) return [];

  const segments: Segment[] = [];
  const hasSpeakable = (s: string): boolean => /[\p{L}\p{N}]/u.test(s);
  const pushNarration = (s: string): void => {
    const text = s.replace(/\s+/g, ' ').trim();
    if (hasSpeakable(text)) segments.push({ kind: 'narration', text });
  };

  const re = /"([^"]+)"|\u201c([^\u201d]+)\u201d/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    pushNarration(clean.slice(last, m.index));
    const inner = (m[1] ?? m[2] ?? '').replace(/\s+/g, ' ').trim();
    if (hasSpeakable(inner)) segments.push({ kind: 'dialogue', text: inner });
    last = re.lastIndex;
  }
  pushNarration(clean.slice(last));
  return segments;
}

/** A coalesced run of consecutive same-voice segments (see {@link planSegmentRuns}). */
export interface SegmentRun {
  /** Voice key (roster name) this run is spoken in. */
  voice: string;
  /** True when the run contains any dialogue (so a clone emote should apply). */
  hasDialogue: boolean;
  /** Concatenated speakable text for the run. */
  text: string;
}

/**
 * Coalesce ordered {@link Segment}s into voice runs for narrated roleplay,
 * merging consecutive segments that resolve to the same voice into one run.
 * Dialogue maps to `dialogueVoice`; narration maps to `narrationVoice`, or is
 * dropped when that is `null` (no narrator voice -> dialogue-only).
 *
 * The point is the same-voice optimization: when `dialogueVoice` ===
 * `narrationVoice` the whole reply collapses into a single continuous run
 * (one synth call per chunk, natural prosody) instead of a request per segment;
 * when they differ, the alternating voices stay separate runs so the two voices
 * interleave. Adjacent same-kind segments (e.g. two quotes split by dropped
 * punctuation) also merge.
 *
 * When `splitByKind` is `true`, runs additionally break on a
 * dialogue<->narration change even within one voice, so each run is
 * single-kind. This keeps the speaker/narrator distinction (and its
 * reference-clip choice) when the same voice is used for both - at the cost of
 * the same-voice prosody merge.
 */
export function planSegmentRuns(
  segments: Segment[],
  dialogueVoice: string,
  narrationVoice: string | null,
  splitByKind = false,
): SegmentRun[] {
  const runs: SegmentRun[] = [];
  let prevKind: Segment['kind'] | undefined;
  for (const seg of segments) {
    const voice = seg.kind === 'dialogue' ? dialogueVoice : narrationVoice;
    if (!voice) continue; // narration dropped when no narrator voice
    const prev = runs[runs.length - 1];
    const mergeable = prev?.voice === voice && (!splitByKind || prevKind === seg.kind);
    if (mergeable && prev) {
      prev.text += ` ${seg.text}`;
      prev.hasDialogue ||= seg.kind === 'dialogue';
    } else {
      runs.push({ voice, hasDialogue: seg.kind === 'dialogue', text: seg.text });
    }
    prevKind = seg.kind;
  }
  return runs;
}

/**
 * Split narration prose into ordered chunks no longer than `maxChars`, breaking
 * only on sentence boundaries (never mid-sentence) and treating blank-line
 * paragraph breaks as hard boundaries. A single sentence longer than `maxChars`
 * is split on clause punctuation, then on word boundaries as a last resort, so
 * a chunk is never silently over the cap. At most `maxChunks` chunks are
 * returned (the tail is dropped) so a runaway reply can't narrate forever.
 *
 * `maxChars` carries two sentinels for endpoints that chunk server-side:
 *   - `0`  -> split by paragraph only (one chunk per blank-line block, no
 *            sentence-level packing or hard-splitting).
 *   - `<0` -> no split: the whole text returns as a single chunk.
 * Either way the result is still capped at `maxChunks`. Callers chunk each
 * speaker/narrator run separately, so the speaker/narrator split is preserved
 * regardless of `maxChars`.
 */
export function chunkProse(text: string, maxChars: number, maxChunks: number): string[] {
  const clean = text.replace(/\r\n?/g, '\n').trim();
  if (!clean) return [];
  const limit = Math.max(1, Math.floor(maxChunks));

  // Sentinel: no split - hand the whole (newline-preserving) text back as one
  // chunk for an endpoint that does its own long-form chunking.
  if (maxChars < 0) return [clean];

  // Sentinel: paragraph-only - each blank-line block is its own chunk, with no
  // sentence-level packing or hard-splitting.
  if (maxChars === 0) {
    const paras: string[] = [];
    for (const para of clean.split(/\n{2,}/)) {
      const p = para.replace(/\s+/g, ' ').trim();
      if (p) paras.push(p);
      if (paras.length >= limit) break;
    }
    return paras.slice(0, limit);
  }

  const cap = Math.max(1, Math.floor(maxChars));

  // Split into paragraphs (blank-line boundaries are hard chunk boundaries),
  // then each paragraph into sentence-ish units.
  const paragraphs: string[][] = [];
  for (const para of clean.split(/\n{2,}/)) {
    const p = para.replace(/\s+/g, ' ').trim();
    if (!p) continue;
    // Sentence terminators: . ! ? (and ellipsis), keeping the punctuation,
    // followed by whitespace. Falls back to the whole paragraph as one unit.
    const sentences = p.match(/[^.!?]+(?:[.!?]+(?:["'\u201d\u2019)\]]+)?|$)/g) ?? [p];
    const units: string[] = [];
    for (const s of sentences) {
      const trimmed = s.trim();
      if (!trimmed) continue;
      // Hard-split any sentence that alone exceeds the cap, so no produced
      // piece is ever over the cap.
      if (trimmed.length <= cap) units.push(trimmed);
      // oxlint-disable-next-line no-use-before-define -- hardSplit is hoisted; defined just below
      else for (const piece of hardSplit(trimmed, cap)) units.push(piece);
    }
    if (units.length > 0) paragraphs.push(units);
  }

  // Greedily pack sentence pieces into chunks up to the cap. A sentence
  // boundary is a legal join point (never break inside a piece); a paragraph
  // boundary is a hard flush so chunks never span paragraphs.
  const chunks: string[] = [];
  let current = '';
  for (const units of paragraphs) {
    if (current) {
      chunks.push(current);
      current = '';
      if (chunks.length >= limit) break;
    }
    for (const piece of units) {
      if (!current) {
        current = piece;
      } else if (current.length + 1 + piece.length <= cap) {
        current = `${current} ${piece}`;
      } else {
        chunks.push(current);
        current = piece;
        if (chunks.length >= limit) break;
      }
    }
    if (chunks.length >= limit) break;
  }
  if (current && chunks.length < limit) chunks.push(current);
  return chunks.slice(0, limit);
}

/**
 * Break a single over-long string into <= `cap` pieces, preferring clause
 * punctuation (`,` `;` `:` `-`) boundaries and falling back to word
 * boundaries; a single word longer than `cap` is hard-sliced.
 */
function hardSplit(text: string, cap: number): string[] {
  const out: string[] = [];
  // Tokenize on clause punctuation (keep it attached) else spaces.
  const tokens = text.match(/[^,;:\-\s]+[,;:-]?|\S/g) ?? [text];
  let current = '';
  const flush = (): void => {
    if (current) out.push(current.trim());
    current = '';
  };
  for (const token of tokens) {
    if (token.length > cap) {
      // A monster token: flush, then hard-slice it.
      flush();
      for (let i = 0; i < token.length; i += cap) out.push(token.slice(i, i + cap));
      continue;
    }
    if (!current) {
      current = token;
    } else if (current.length + 1 + token.length <= cap) {
      current = `${current} ${token}`;
    } else {
      flush();
      current = token;
    }
  }
  flush();
  return out.filter((p) => p.length > 0);
}
