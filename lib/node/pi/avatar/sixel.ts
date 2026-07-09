/**
 * Pure RGBA -> sixel encoder for the `avatar` extension.
 *
 * Windows Terminal (>= 1.22) renders sixel rather than the kitty / iTerm2
 * inline-image protocols, so the sixel path has to ship actual pixels: take
 * the RGBA from {@link decodePng}, scale it to the on-screen footprint
 * (nearest-neighbour, which suits pixel art), quantise to a palette, and
 * emit the sixel DCS string the terminal paints.
 *
 * Transparency is preserved with the sixel "background select" flag (`P2 = 1`
 * in the introducer): pixels below the alpha threshold are simply never set,
 * so they stay transparent. No pi imports - unit-testable.
 */

const ESC = '\x1b';
/**
 * Alpha at or above this counts as opaque; below it is left transparent.
 * Shared with the half-block renderer ({@link ./halfblock.ts}) so both pixel
 * paths key transparency off the same cutoff.
 */
export const ALPHA_THRESHOLD = 128;

/**
 * Prefix prepended to the rendered sixel line so pi-tui treats it as an inline
 * image and skips its width-truncation guard.
 *
 * pi-tui's `isImageLine()` only recognises kitty (`ESC _G`) and iTerm2
 * (`ESC ]1337;File=`) lines; a sixel DCS line (`ESC P ... ESC \`) is not
 * recognised, and pi-tui's `visibleWidth()` does not strip DCS, so the
 * multi-kilobyte sixel payload is counted as visible columns and the renderer
 * throws "Rendered line N exceeds terminal width". This marker is an empty
 * kitty graphics APC command (`m=0`, no payload): kitty-incapable terminals
 * such as Windows Terminal ignore the unknown APC and paint the sixel that
 * follows, while pi-tui sees the `ESC _G` substring and exempts the line from
 * the guard. (Mirrors the approach used by the `pi-image-tools` extension.)
 */
export const SIXEL_IMAGE_LINE_MARKER = `${ESC}_Gm=0;${ESC}\\`;

export interface RgbaImage {
  width: number;
  height: number;
  /** Row-major RGBA, 4 bytes per pixel. */
  rgba: Uint8Array;
}

interface Quantized {
  /** Palette colours as `[r, g, b]` in the 0-255 range. */
  palette: [number, number, number][];
  /** Per-pixel palette index, row-major; `-1` marks a transparent pixel. */
  index: Int16Array;
}

/** Scale `src` to `dstW` x `dstH` with nearest-neighbour sampling. */
export function resizeNearest(src: RgbaImage, dstW: number, dstH: number): RgbaImage {
  const width = Math.max(1, Math.round(dstW));
  const height = Math.max(1, Math.round(dstH));
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / width));
      const so = (sy * src.width + sx) * 4;
      const o = (y * width + x) * 4;
      out[o] = src.rgba[so];
      out[o + 1] = src.rgba[so + 1];
      out[o + 2] = src.rgba[so + 2];
      out[o + 3] = src.rgba[so + 3];
    }
  }
  return { width, height, rgba: out };
}

interface Bucket {
  pixels: number[];
}

/** Widest single-channel spread of the pixels in `bucket`. */
function spread(rgba: Uint8Array, pixels: number[]): { range: number; channel: number } {
  const min = [255, 255, 255];
  const max = [0, 0, 0];
  for (const i of pixels) {
    const o = i * 4;
    for (let c = 0; c < 3; c++) {
      const v = rgba[o + c];
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
    }
  }
  const ranges = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  let channel = 0;
  if (ranges[1] >= ranges[0] && ranges[1] >= ranges[2]) channel = 1;
  else if (ranges[2] >= ranges[0] && ranges[2] >= ranges[1]) channel = 2;
  return { range: ranges[channel], channel };
}

/** Median-cut quantisation of the opaque pixels of `img` to at most `maxColors`. */
function quantize(img: RgbaImage, maxColors: number): Quantized {
  const { rgba, width, height } = img;
  const total = width * height;
  const index = new Int16Array(total).fill(-1);

  const opaque: number[] = [];
  for (let i = 0; i < total; i++) {
    if (rgba[i * 4 + 3] >= ALPHA_THRESHOLD) opaque.push(i);
  }
  if (opaque.length === 0) return { palette: [], index };

  const buckets: Bucket[] = [{ pixels: opaque }];
  while (buckets.length < maxColors) {
    let target = -1;
    let targetChannel = 0;
    let best = 0;
    for (let bi = 0; bi < buckets.length; bi++) {
      if (buckets[bi].pixels.length < 2) continue;
      const { range, channel } = spread(rgba, buckets[bi].pixels);
      if (range > best) {
        best = range;
        target = bi;
        targetChannel = channel;
      }
    }
    if (target < 0 || best <= 0) break;
    const pixels = buckets[target].pixels;
    pixels.sort((a, b) => rgba[a * 4 + targetChannel] - rgba[b * 4 + targetChannel]);
    const mid = pixels.length >> 1;
    buckets.splice(target, 1, { pixels: pixels.slice(0, mid) }, { pixels: pixels.slice(mid) });
  }

  const palette: [number, number, number][] = [];
  for (let bi = 0; bi < buckets.length; bi++) {
    const pixels = buckets[bi].pixels;
    let r = 0;
    let g = 0;
    let b = 0;
    for (const i of pixels) {
      const o = i * 4;
      r += rgba[o];
      g += rgba[o + 1];
      b += rgba[o + 2];
    }
    const count = pixels.length || 1;
    palette.push([Math.round(r / count), Math.round(g / count), Math.round(b / count)]);
    for (const i of pixels) index[i] = bi;
  }
  return { palette, index };
}

/** Scale a 0-255 channel to the 0-100 range sixel colour registers use. */
function to100(value: number): number {
  return Math.round((value * 100) / 255);
}

/** Run-length encode one colour's sixel band row, trimming trailing blanks. */
function encodeRow(values: number[]): string {
  let end = values.length;
  while (end > 0 && values[end - 1] === 0) end--;
  let out = '';
  let i = 0;
  while (i < end) {
    const value = values[i];
    let run = 1;
    while (i + run < end && values[i + run] === value) run++;
    const ch = String.fromCharCode(63 + value);
    out += run >= 4 ? `!${run}${ch}` : ch.repeat(run);
    i += run;
  }
  return out;
}

/**
 * Encode `img` as a sixel DCS string (`ESC P ... ESC \`). The introducer
 * sets `P2 = 1` so unset (transparent) pixels are left untouched, and a
 * raster-attributes header advertises the pixel dimensions. Pixels are
 * emitted in 6-row bands, one colour pass per band.
 */
export function encodeSixel(img: RgbaImage, maxColors = 255): string {
  const { width, height } = img;
  const { palette, index } = quantize(img, Math.max(1, Math.min(255, maxColors)));

  let out = `${ESC}P0;1;0q"1;1;${width};${height}`;
  for (let c = 0; c < palette.length; c++) {
    const [r, g, b] = palette[c];
    out += `#${c};2;${to100(r)};${to100(g)};${to100(b)}`;
  }

  const bands = Math.ceil(height / 6);
  for (let band = 0; band < bands; band++) {
    const y0 = band * 6;
    const rows = Math.min(6, height - y0);
    const colorRuns: string[] = [];
    for (let c = 0; c < palette.length; c++) {
      const values = Array.from({ length: width }, () => 0);
      let any = false;
      for (let x = 0; x < width; x++) {
        let bits = 0;
        for (let r = 0; r < rows; r++) {
          if (index[(y0 + r) * width + x] === c) bits |= 1 << r;
        }
        values[x] = bits;
        if (bits !== 0) any = true;
      }
      if (any) colorRuns.push(`#${c}${encodeRow(values)}`);
    }
    out += colorRuns.join('$');
    if (band < bands - 1) out += '-';
  }

  return `${out}${ESC}\\`;
}
