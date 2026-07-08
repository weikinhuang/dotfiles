/**
 * Frame-store data structures + pure factories for the `avatar` extension.
 *
 * A `RenderedFrame` is one paintable avatar frame: a terminal image escape
 * (kitty / iTerm2 / sixel), a half-block cell grid, or a kaomoji text block.
 * A `LoadedState` is one animation state's frames, materialised lazily so an
 * image set only pays its decode/encode cost on first display; a `FrameStore`
 * maps a state name (`idle`, `talk`, `happy`, …) to its `LoadedState`.
 *
 * The timer-driven animator and the pi-tui-coupled renderer live in the
 * extension shell (`config/pi/extensions/avatar.ts`); only the pure store
 * data structures + the frame-selection / materialisation helpers live here
 * so they can be unit-tested with vitest.
 */

/** One paintable avatar frame. */
export type RenderedFrame =
  | { kind: 'image'; sequence: string; rows: number; style: 'kitty' | 'iterm2' | 'sixel' }
  | { kind: 'halfblock'; cells: string[]; rows: number }
  | { kind: 'text'; lines: string[] };

/** One animation state's frames. */
export interface LoadedState {
  /** Number of frames in this state (known without materialising them). */
  readonly length: number;
  /** Materialise (and memoise) the frame at `index`, or null if absent. */
  frameAt(index: number): RenderedFrame | null;
}

/** State name (`idle`, `talk`, `happy`, …) -> its frames. */
export type FrameStore = Map<string, LoadedState>;

/** A discovered store plus the list of emotion-overlay state names it holds. */
export interface BuiltStore {
  store: FrameStore;
  emotions: string[];
}

/**
 * Wrap `index` into `[0, length)` with Python-style modulo so negative
 * indices count from the end. Callers must ensure `length > 0`.
 */
export function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}

/** A state whose frames are already materialised (ASCII/text - cheap to build). */
export function readyState(frames: RenderedFrame[]): LoadedState {
  return {
    length: frames.length,
    frameAt: (i) => (i >= 0 && i < frames.length ? frames[i] : null),
  };
}

/**
 * A state whose image frames are built on first display and memoised for the
 * rest of the session (animation ticks re-hit the memo, never re-encode).
 */
export function lazyImageState(paths: string[], build: (pngPath: string) => RenderedFrame | null): LoadedState {
  const memo: (RenderedFrame | null | undefined)[] = Array.from<RenderedFrame | null | undefined>({
    length: paths.length,
  });
  return {
    length: paths.length,
    frameAt(i) {
      if (i < 0 || i >= paths.length) return null;
      const cached = memo[i];
      if (cached !== undefined) return cached;
      const built = build(paths[i]);
      memo[i] = built;
      return built;
    },
  };
}

/** Normalise an ASCII-YAML frame value (string / array / map) into frame lines. */
export function asciiFramesToLines(value: string | string[] | Record<string, string>): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value;
  return Object.values(value);
}
