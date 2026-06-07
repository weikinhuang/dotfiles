/**
 * Pure PNG `tEXt` chunk reader for SillyTavern character-card PNGs.
 *
 * No pi imports - unit-testable under `vitest`. Uses only the Node
 * `Buffer` global for base64 decoding.
 *
 * SillyTavern (and TavernAI) embed the character-card JSON in a PNG
 * textual chunk: keyword `chara` holds a base64-encoded Character Card V2
 * JSON, and `ccv3` holds a base64-encoded V3 JSON. This module walks the
 * PNG chunk structure, pulls those chunks out, and base64-decodes them to
 * the raw JSON string. It does not parse the card itself - see
 * `card-to-records.ts`.
 *
 * Only uncompressed `tEXt` chunks are read (what ST writes). Compressed
 * `zTXt` / `iTXt` chunks are not supported and are ignored.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** True when `bytes` starts with the 8-byte PNG signature. */
export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

function readUInt32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function latin1(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i] ?? 0);
  return out;
}

/**
 * Extract every `tEXt` chunk as `keyword -> text`. A `tEXt` chunk's data
 * is `keyword\0text`; both are Latin-1. On a malformed / truncated chunk
 * the walk stops and what was parsed so far is returned. Later duplicate
 * keywords win.
 */
export function parsePngTextChunks(bytes: Uint8Array): Map<string, string> {
  const chunks = new Map<string, string>();
  if (!isPng(bytes)) return chunks;

  let pos = PNG_SIGNATURE.length;
  while (pos + 8 <= bytes.length) {
    const length = readUInt32BE(bytes, pos);
    const type = latin1(bytes, pos + 4, pos + 8);
    const dataStart = pos + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) break; // truncated (data + CRC)

    if (type === 'tEXt') {
      let sep = -1;
      for (let i = dataStart; i < dataEnd; i++) {
        if (bytes[i] === 0) {
          sep = i;
          break;
        }
      }
      if (sep !== -1) {
        const keyword = latin1(bytes, dataStart, sep);
        const text = latin1(bytes, sep + 1, dataEnd);
        chunks.set(keyword, text);
      }
    }

    if (type === 'IEND') break;
    pos = dataEnd + 4; // skip CRC
  }
  return chunks;
}

function decodeBase64(text: string): string | null {
  try {
    // Tolerate embedded whitespace/newlines some writers insert.
    return Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Extract the embedded character-card JSON string from a PNG. Prefers the
 * V3 (`ccv3`) chunk over the V2 (`chara`) chunk when both are present.
 * Returns `null` when the bytes aren't a PNG or carry no card chunk.
 */
export function extractCardJson(bytes: Uint8Array): string | null {
  const chunks = parsePngTextChunks(bytes);
  const encoded = chunks.get('ccv3') ?? chunks.get('chara');
  if (encoded === undefined) return null;
  const json = decodeBase64(encoded);
  return json !== null && json.trim().length > 0 ? json : null;
}
