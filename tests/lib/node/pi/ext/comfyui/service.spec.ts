import { expect, test } from 'vitest';
import {
  getComfyuiGenerator,
  installComfyuiGenerator,
  type ComfyuiGenerator,
} from '../../../../../../lib/node/pi/ext/comfyui/service.ts';

test('executor access is identity-safe across reload cleanup', () => {
  const first: ComfyuiGenerator = () =>
    Promise.resolve({ content: [], details: { workflow: 'first', savedPaths: [] } });
  const second: ComfyuiGenerator = () =>
    Promise.resolve({ content: [], details: { workflow: 'second', savedPaths: [] } });
  const clearFirst = installComfyuiGenerator(first);
  expect(getComfyuiGenerator()).toBe(first);
  const clearSecond = installComfyuiGenerator(second);
  clearFirst();
  expect(getComfyuiGenerator()).toBe(second);
  clearSecond();
  clearSecond();
  expect(getComfyuiGenerator()).toBeUndefined();
});
