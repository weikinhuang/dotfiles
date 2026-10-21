/**
 * Pure guard for reasoning text that leaks into visible assistant content.
 *
 * llama.cpp's reasoning parser splits the FIRST `<think>…</think>` span
 * into `reasoning_content`. Qwen-family models occasionally keep
 * deliberating after that split, write a draft answer into the visible
 * channel, emit a second literal `</think>`, and then write the real
 * answer. The server streams all of that as plain `content`, so the user
 * sees `draft </think> final`. Server flags cannot fix it (the first span
 * was parsed correctly); the transcript has to be repaired client-side.
 *
 * {@link splitLeakedThinking} moves everything before the LAST `</think>`
 * in a text part into a `thinking` part and keeps only the trailing
 * answer visible. When nothing follows the tag the text stays visible
 * (with the tags stripped) so a reply is never hidden entirely.
 */

export const THINK_CLOSE = '</think>';
const THINK_TAG_RE = /<\/?think>/g;
const HAS_THINK_TAG = /<\/?think>/;

export interface ContentPartLike {
  type?: string;
  text?: string;
  thinking?: string;
  thinkingSignature?: string;
  [key: string]: unknown;
}

/** True when any visible text part carries a `<think>` / `</think>` tag. */
export function hasLeakedThinkTag(content: readonly ContentPartLike[]): boolean {
  return content.some((p) => p.type === 'text' && typeof p.text === 'string' && HAS_THINK_TAG.test(p.text));
}

/**
 * Return a repaired copy of `content`, or `undefined` when no text part
 * carries a think tag (callers then keep the original message untouched).
 * A moved segment reuses the signature of an existing thinking part so
 * replay through the OpenAI-completions client stays on the same field
 * (`reasoning_content` by default).
 */
export function splitLeakedThinking(content: readonly ContentPartLike[]): ContentPartLike[] | undefined {
  if (!hasLeakedThinkTag(content)) return undefined;
  const signature =
    content.find((p) => p.type === 'thinking' && typeof p.thinkingSignature === 'string')?.thinkingSignature ??
    'reasoning_content';
  const out: ContentPartLike[] = [];
  for (const part of content) {
    if (part.type !== 'text' || typeof part.text !== 'string' || !HAS_THINK_TAG.test(part.text)) {
      out.push(part);
      continue;
    }
    const text = part.text;
    const close = text.lastIndexOf(THINK_CLOSE);
    const answer =
      close >= 0
        ? text
            .slice(close + THINK_CLOSE.length)
            .replace(THINK_TAG_RE, '')
            .trim()
        : '';
    if (close < 0 || answer.length === 0) {
      // Stray opener only, or nothing after the last closer: keep it visible, minus the tags.
      out.push({ ...part, text: text.replace(THINK_TAG_RE, '').trim() });
      continue;
    }
    const reasoning = text.slice(0, close).replace(THINK_TAG_RE, '').trim();
    if (reasoning.length > 0) out.push({ type: 'thinking', thinking: reasoning, thinkingSignature: signature });
    out.push({ ...part, text: answer });
  }
  return out;
}
