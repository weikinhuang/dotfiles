/** Escape terminal controls and bidi overrides in explicitly requested local scene text. */
export function escapeRoleplayReportText(text: string): string {
  let output = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    const control = (code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159);
    const bidi = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    output += control || bidi ? `\\u${code.toString(16).padStart(4, '0')}` : character;
  }
  return output;
}
