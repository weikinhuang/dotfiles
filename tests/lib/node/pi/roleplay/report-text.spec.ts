import { expect, test } from 'vitest';
import { escapeRoleplayReportText } from '../../../../../lib/node/pi/roleplay/report-text.ts';

test('terminal controls and bidi overrides are escaped while normal Unicode and layout are retained', () => {
  const controls = String.fromCharCode(0, 7, 13, 27, 127, 155, 0x202e, 0x2066);
  expect(escapeRoleplayReportText(controls)).toBe('\\u0000\\u0007\\u000d\\u001b\\u007f\\u009b\\u202e\\u2066');
  expect(escapeRoleplayReportText('Scene\n\t你好 🌊')).toBe('Scene\n\t你好 🌊');
});
