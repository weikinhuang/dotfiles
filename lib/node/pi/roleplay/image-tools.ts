/** Image-mode policy shared by persona activation and roleplay commands. */
import { createGlobalSlot } from '../global-slot.ts';

export type RoleplayImageMode = 'simple' | 'full' | 'off';
export const ROLEPLAY_IMAGE_MODE_ENTRY = 'roleplay-image-mode';
const IMAGE_TOOLS = new Set(['generate_image', 'image_jobs', 'roleplay_image']);
const getSlot = createGlobalSlot<{ override?: RoleplayImageMode }>('@dotfiles/pi/roleplay/image-mode', () => ({}));

export function isRoleplayImageMode(value: unknown): value is RoleplayImageMode {
  return value === 'simple' || value === 'full' || value === 'off';
}

export function setRoleplayImageModeOverride(mode: RoleplayImageMode | undefined): void {
  getSlot().override = mode;
}

export function getRoleplayImageModeOverride(): RoleplayImageMode | undefined {
  return getSlot().override;
}

export function restoreRoleplayImageMode(entries: readonly unknown[]): RoleplayImageMode | undefined {
  let mode: RoleplayImageMode | undefined;
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    if (entry.type !== 'custom' || entry.customType !== ROLEPLAY_IMAGE_MODE_ENTRY) continue;
    if (isRoleplayImageMode(entry.data)) mode = entry.data;
  }
  return mode;
}

/** An explicit persona image allowlist grants either interface, but never adds unrelated tools. */
export function selectRoleplayImageTools(
  requested: readonly string[],
  registered: ReadonlySet<string>,
  roleplay: boolean,
  mode: RoleplayImageMode,
): string[] {
  if (!roleplay) return requested.filter((name) => name !== 'roleplay_image');
  const result = requested.filter((name) => !IMAGE_TOOLS.has(name));
  const allowed = requested.includes('generate_image') || requested.includes('roleplay_image');
  if (mode === 'off') return result;
  if (!allowed) {
    // Full mode also preserves a pre-existing jobs-only allowlist.
    return mode === 'full' && requested.includes('image_jobs') && registered.has('image_jobs')
      ? [...result, 'image_jobs']
      : result;
  }
  const names =
    mode === 'simple'
      ? ['roleplay_image']
      : ['generate_image', ...(requested.includes('image_jobs') ? ['image_jobs'] : [])];
  return [...result, ...names.filter((name) => registered.has(name))];
}

/** Replace only image tools when a slash command changes modes; preserve every other active tool. */
export function replaceRoleplayImageTools(current: readonly string[], selected: readonly string[]): string[] {
  return [...current.filter((name) => !IMAGE_TOOLS.has(name)), ...selected.filter((name) => IMAGE_TOOLS.has(name))];
}
