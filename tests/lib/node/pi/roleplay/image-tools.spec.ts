import { afterEach, expect, test } from 'vitest';
import {
  getRoleplayImageModeOverride,
  isRoleplayImageMode,
  replaceRoleplayImageTools,
  restoreRoleplayImageMode,
  ROLEPLAY_IMAGE_MODE_ENTRY,
  selectRoleplayImageTools,
  setRoleplayImageModeOverride,
} from '../../../../../lib/node/pi/roleplay/image-tools.ts';

const registered = new Set(['read', 'roleplay', 'roleplay_image', 'generate_image', 'image_jobs']);
const requested = ['read', 'roleplay', 'generate_image', 'image_jobs'];
afterEach(() => setRoleplayImageModeOverride(undefined));
test('simple replaces full tools; full and off retain their contracts', () => {
  expect(selectRoleplayImageTools(requested, registered, true, 'simple')).toEqual([
    'read',
    'roleplay',
    'roleplay_image',
  ]);
  expect(selectRoleplayImageTools(requested, registered, true, 'full')).toEqual(requested);
  expect(selectRoleplayImageTools(requested, registered, true, 'off')).toEqual(['read', 'roleplay']);
});
test('mode changes cannot grant permissions absent from an explicit allowlist', () => {
  expect(selectRoleplayImageTools(['read', 'roleplay'], registered, true, 'simple')).toEqual(['read', 'roleplay']);
  expect(selectRoleplayImageTools(['read', 'image_jobs'], registered, true, 'simple')).toEqual(['read']);
  expect(selectRoleplayImageTools(['read', 'image_jobs'], registered, true, 'full')).toEqual(['read', 'image_jobs']);
  expect(selectRoleplayImageTools(['read', 'roleplay_image'], registered, true, 'full')).toEqual([
    'read',
    'generate_image',
  ]);
});
test('coding personas keep ComfyUI intact but never see the facade', () => {
  expect(selectRoleplayImageTools([...requested, 'roleplay_image'], registered, false, 'simple')).toEqual(requested);
});

test('unrestricted personas can restore images after off mode without granting unrelated tools', () => {
  const unrestricted = [...registered];
  const off = replaceRoleplayImageTools(
    ['read', 'roleplay_image'],
    selectRoleplayImageTools(unrestricted, registered, true, 'off'),
  );
  expect(off).toEqual(['read']);
  const full = replaceRoleplayImageTools(off, selectRoleplayImageTools(unrestricted, registered, true, 'full'));
  expect(full).toEqual(['read', 'generate_image', 'image_jobs']);
});
test('missing registrations and unrelated active tools are preserved correctly', () => {
  expect(selectRoleplayImageTools(requested, new Set(['read']), true, 'simple')).toEqual(['read', 'roleplay']);
  expect(replaceRoleplayImageTools(['read', 'custom', 'generate_image'], ['roleplay', 'roleplay_image'])).toEqual([
    'read',
    'custom',
    'roleplay_image',
  ]);
});
test('mode overrides validate, reset, and restore from branch-local entries', () => {
  expect(isRoleplayImageMode('simple')).toBe(true);
  expect(isRoleplayImageMode('other')).toBe(false);
  const first = { type: 'custom', customType: ROLEPLAY_IMAGE_MODE_ENTRY, data: 'simple' };
  expect(restoreRoleplayImageMode([first, { ...first, data: 'off' }])).toBe('off');
  expect(restoreRoleplayImageMode([first])).toBe('simple');
  expect(restoreRoleplayImageMode([null, { ...first, data: 'bad' }])).toBeUndefined();
  setRoleplayImageModeOverride('simple');
  expect(getRoleplayImageModeOverride()).toBe('simple');
  setRoleplayImageModeOverride(undefined);
  expect(getRoleplayImageModeOverride()).toBeUndefined();
});
