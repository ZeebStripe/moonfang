import { encodePNG } from './exporter';
import { makeAsset, type TextureAsset } from './library';

/** A decal brush in the user's library: two images made from one imported picture. */
export interface Decal {
  id: string;
  name: string;
  /** RGBA: colour, alpha = where the decal is (the stamp shape and the shelf preview) */
  maskId: string;
  /** RGB colour + A = height (auto-generated relief), what the paint pass reads */
  surfaceId: string;
  group?: string;
}

export interface DecalResult {
  decal: Decal;
  assets: TextureAsset[];
  /** how the background was handled, for the import message */
  background: 'alpha' | 'removed' | 'kept';
}

const MAX_SOURCE = 1024;
const MAX_DECAL = 512;

/**
 * Turns any picture into a decal brush, automatically:
 *  - transparency: uses the image's own alpha; otherwise removes a plain background (flood fill from the border,
 *    soft edges, edge colours cleaned of the background colour); a photo without a plain border stays rectangular
 *  - trims empty space and centres it in a square (≤ 512 px)
 *  - height: a raised, bevelled plateau from the shape plus relief from the image's brightness
 */
export async function makeDecal(fileName: string, bytes: Uint8Array): Promise<DecalResult> {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart]), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const s = Math.min(1, MAX_SOURCE / Math.max(bmp.width, bmp.height));
  const W = Math.max(1, Math.round(bmp.width * s));
  const H = Math.max(1, Math.round(bmp.height * s));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0, W, H);
  bmp.close();
  const px = g.getImageData(0, 0, W, H).data;

  let background: DecalResult['background'] = 'alpha';
  let transparent = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 250) transparent++;
  if (transparent < W * H * 0.01) background = removeBackground(px, W, H) ? 'removed' : 'kept';

  const sq = trimToSquare(px, W, H);
  const surface = surfaceMap(sq.px, sq.size);
  const name = fileName.replace(/\.[^.]+$/, '');
  const base = name.replace(/[^\w\-]+/g, '_') || 'decal';
  const mask = await makeAsset(`${base}_decal.png`, encodePNG(sq.px, sq.size, sq.size, 4, false), 'image/png');
  const surf = await makeAsset(`${base}_decal_surface.png`, encodePNG(surface, sq.size, sq.size, 4, false), 'image/png');
  return { decal: { id: `decal_${mask.id}`, name, maskId: mask.id, surfaceId: surf.id }, assets: [mask, surf], background };
}

/** Makes a plain, border-connected background transparent. Returns false when the border isn't one colour. */
function removeBackground(px: Uint8ClampedArray, W: number, H: number): boolean {
  // Background colour: the median of the border pixels; it must be uniform enough to be a backdrop.
  const border: number[] = [];
  for (let x = 0; x < W; x++) border.push(x, (H - 1) * W + x);
  for (let y = 1; y < H - 1; y++) border.push(y * W, y * W + W - 1);
  const med = (k: number) => {
    const v = border.map((i) => px[i * 4 + k]).sort((a, b) => a - b);
    return v[v.length >> 1];
  };
  const bg = [med(0), med(1), med(2)];
  const dist = (i: number) => Math.hypot(px[i * 4] - bg[0], px[i * 4 + 1] - bg[1], px[i * 4 + 2] - bg[2]);
  const T = 42;
  const close = border.filter((i) => dist(i) < T).length;
  if (close < border.length * 0.85) return false;

  // Flood fill from the border through background-coloured pixels (holes inside letters stay if not connected).
  const isBg = new Uint8Array(W * H);
  const stack: number[] = [];
  for (const i of border) if (!isBg[i] && dist(i) < T) (isBg[i] = 1), stack.push(i);
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % W;
    const y = (i - x) / W;
    for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
      if (j >= 0 && !isBg[j] && dist(j) < T) {
        isBg[j] = 1;
        stack.push(j);
      }
    }
  }
  for (let i = 0; i < W * H; i++) {
    if (isBg[i]) {
      px[i * 4 + 3] = 0;
      continue;
    }
    // Pixels touching the background get a soft edge, with the background colour taken out of them.
    const x = i % W;
    const y = (i - x) / W;
    const edge = (x > 0 && isBg[i - 1]) || (x < W - 1 && isBg[i + 1]) || (y > 0 && isBg[i - W]) || (y < H - 1 && isBg[i + W]);
    if (!edge) continue;
    const a = Math.min(1, Math.max(0.15, (dist(i) - T * 0.5) / (T * 1.5)));
    for (let k = 0; k < 3; k++) px[i * 4 + k] = Math.min(255, Math.max(0, Math.round((px[i * 4 + k] - (1 - a) * bg[k]) / a)));
    px[i * 4 + 3] = Math.round(a * 255);
  }
  return true;
}

/** Crops to the visible pixels (plus a small margin), centres them in a square and scales it to ≤ MAX_DECAL. */
function trimToSquare(px: Uint8ClampedArray, W: number, H: number): { px: Uint8Array; size: number } {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (px[(y * W + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error('The image is completely transparent.');
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const side = Math.ceil(Math.max(w, h) * 1.04) + 2;
  const size = Math.min(MAX_DECAL, side);
  const scale = size / side;
  const out = new Uint8Array(size * size * 4);
  const ox = (side - w) / 2 - x0;
  const oy = (side - h) / 2 - y0;
  // Box-filtered resample (straight alpha: colours are weighted by alpha so transparent pixels don't darken edges).
  const step = 1 / scale;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, gg = 0, b = 0, a = 0, n = 0;
      const sx0 = x * step - ox, sy0 = y * step - oy;
      for (let sy = Math.floor(sy0); sy < Math.max(Math.floor(sy0) + 1, Math.ceil(sy0 + step)); sy++) {
        for (let sx = Math.floor(sx0); sx < Math.max(Math.floor(sx0) + 1, Math.ceil(sx0 + step)); sx++) {
          n++;
          if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
          const k = (sy * W + sx) * 4;
          const pa = px[k + 3];
          r += px[k] * pa;
          gg += px[k + 1] * pa;
          b += px[k + 2] * pa;
          a += pa;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = r / a;
        out[o + 1] = gg / a;
        out[o + 2] = b / a;
      }
      out[o + 3] = a / n;
    }
  }
  return { px: out, size };
}

/** RGB = colour, A = height: a bevelled plateau from the shape plus brightness relief inside it. */
function surfaceMap(px: Uint8Array, size: number): Uint8Array {
  const n = size * size;
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) alpha[i] = px[i * 4 + 3] / 255;
  const plateau = boxBlur(boxBlur(alpha, size, Math.max(1, Math.round(size * 0.015))), size, Math.max(1, Math.round(size * 0.015)));
  // Brightness relief, normalised over the decal's own range.
  let lo = 1, hi = 0;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    lum[i] = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;
    if (alpha[i] > 0.5) {
      lo = Math.min(lo, lum[i]);
      hi = Math.max(hi, lum[i]);
    }
  }
  const range = hi - lo > 0.05 ? hi - lo : 1;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const detail = ((lum[i] - lo) / range) * alpha[i];
    out[i * 4] = px[i * 4];
    out[i * 4 + 1] = px[i * 4 + 1];
    out[i * 4 + 2] = px[i * 4 + 2];
    out[i * 4 + 3] = Math.round(255 * Math.min(1, plateau[i] * 0.7 + detail * 0.3));
  }
  return out;
}

function boxBlur(src: Float32Array, size: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const k = 2 * r + 1;
  for (let y = 0; y < size; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[y * size + Math.min(size - 1, Math.max(0, x))];
    for (let x = 0; x < size; x++) {
      tmp[y * size + x] = acc / k;
      acc += src[y * size + Math.min(size - 1, x + r + 1)] - src[y * size + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < size; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(size - 1, Math.max(0, y)) * size + x];
    for (let y = 0; y < size; y++) {
      out[y * size + x] = acc / k;
      acc += tmp[Math.min(size - 1, y + r + 1) * size + x] - tmp[Math.max(0, y - r) * size + x];
    }
  }
  return out;
}
