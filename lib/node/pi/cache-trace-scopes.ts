import { createHash } from 'node:crypto';

import { extractContentText } from './message-text.ts';
import { isRecord } from './shared/guards.ts';

export interface CacheTraceScope {
  bytes: number;
  sha256: string;
  sources: string[];
  changed: boolean | null;
}

export interface ExtractedTraceScope {
  serialized: string;
  text: string;
  metadata: CacheTraceScope;
}

export function traceHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Extract only known system fields/roles and declarations, never conversation or tool-result text. */
export function extractTraceScopes(payload: unknown): { system: ExtractedTraceScope; tools: ExtractedTraceScope } {
  const system: { source: string; value: unknown }[] = [];
  const tools: { source: string; value: unknown }[] = [];
  if (isRecord(payload)) {
    for (const key of ['system', 'instructions', 'systemInstruction']) {
      if (payload[key] !== undefined) system.push({ source: key, value: payload[key] });
    }
    for (const key of ['tools', 'toolConfig']) {
      if (payload[key] !== undefined) tools.push({ source: key, value: payload[key] });
    }
    for (const key of ['messages', 'input']) {
      if (!Array.isArray(payload[key])) continue;
      (payload[key] as unknown[]).forEach((item, index) => {
        if (!isRecord(item)) return;
        if ((item.role === 'system' || item.role === 'developer') && item.content !== undefined) {
          system.push({ source: `${key}[${index}].${String(item.role)}`, value: item.content });
        }
        if (item.type === 'additional_tools' && item.tools !== undefined) {
          tools.push({ source: `${key}[${index}].tools`, value: item.tools });
        }
      });
    }
  }
  const build = (parts: { source: string; value: unknown }[], scope: 'system' | 'tools'): ExtractedTraceScope => {
    const serialized = JSON.stringify(parts);
    const text = parts
      .map(({ source, value }) => {
        const content = isRecord(value) && Array.isArray(value.parts) ? value.parts : value;
        const body =
          scope === 'tools'
            ? JSON.stringify(value, null, 2)
            : extractContentText(content, { types: ['text', 'input_text'], allowUntypedText: true });
        return `## ${source}\n${body}`;
      })
      .join('\n\n');
    return {
      serialized,
      text,
      metadata: {
        bytes: Buffer.byteLength(serialized),
        sha256: traceHash(serialized),
        sources: parts.map((part) => part.source),
        changed: null,
      },
    };
  };
  return { system: build(system, 'system'), tools: build(tools, 'tools') };
}
