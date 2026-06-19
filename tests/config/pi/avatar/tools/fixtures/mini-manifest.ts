import { makeManifest, type SpriteGroup } from '../../../../../../config/pi/avatar/tools/sprite-manifest.ts';

/**
 * A tiny, character-agnostic manifest used to exercise the `--manifest` external
 * load path in manifest-loader.spec.ts. Mirrors the shape a device-local
 * character manifest uses: define groups, call `makeManifest`, export `manifest`.
 */
const GROUPS: Record<string, SpriteGroup> = {
  demo: {
    tier: 'demo',
    states: ['wave', 'nod'],
    poses: { wave: 'waving hello', nod: 'a sure nod' },
    frames: {},
  },
};

export const manifest = makeManifest(GROUPS, ['demo']);
