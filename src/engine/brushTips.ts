import * as THREE from 'three';
import { makeAsset, type TextureAsset } from './library';

/** A brush tip is a greyscale image: white paints, black doesn't. 'round' is procedural (uses hardness). */
export interface BrushTip {
  id: string;
  name: string;
  /** user tips: texture asset id */
  assetId?: string;
}

const SIZE = 256;

/** Seeded PRNG so built-in tips look the same every session. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

const DRAW: Record<string, (g: CanvasRenderingContext2D) => void> = {
  square: (g) => {
    g.fillStyle = '#fff';
    g.fillRect(SIZE * 0.12, SIZE * 0.12, SIZE * 0.76, SIZE * 0.76);
  },
  splatter: (g) => {
    const r = rng(7);
    g.fillStyle = '#fff';
    for (let i = 0; i < 70; i++) {
      const a = r() * Math.PI * 2;
      const d = Math.pow(r(), 0.7) * SIZE * 0.44;
      g.beginPath();
      g.arc(SIZE / 2 + Math.cos(a) * d, SIZE / 2 + Math.sin(a) * d, 2 + r() * (16 - d / 12), 0, Math.PI * 2);
      g.fill();
    }
  },
  grunge: (g) => {
    const img = g.createImageData(SIZE, SIZE);
    const r = rng(11);
    const grid = 16;
    const lattice = Array.from({ length: (grid + 1) * (grid + 1) }, () => r());
    const at = (x: number, y: number) => lattice[y * (grid + 1) + x];
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        let v = 0;
        let amp = 0.5;
        for (let o = 1; o <= 4; o *= 2) {
          const fx = ((x / SIZE) * grid * o) % grid;
          const fy = ((y / SIZE) * grid * o) % grid;
          const ix = Math.floor(fx),
            iy = Math.floor(fy);
          const tx = fx - ix,
            ty = fy - iy;
          const n = (at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx) * (1 - ty) + (at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx) * ty;
          v += n * amp;
          amp *= 0.5;
        }
        const d = Math.hypot(x - SIZE / 2, y - SIZE / 2) / (SIZE / 2);
        const fall = Math.max(0, 1 - d * d);
        const val = Math.max(0, Math.min(1, (v - 0.42) * 4)) * fall;
        const i = (y * SIZE + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = val * 255;
        img.data[i + 3] = 255;
      }
    g.putImageData(img, 0, 0);
  },
  scratches: (g) => {
    const r = rng(23);
    g.strokeStyle = '#fff';
    g.lineCap = 'round';
    for (let i = 0; i < 26; i++) {
      const y = SIZE * (0.15 + r() * 0.7);
      const x0 = SIZE * (0.05 + r() * 0.3);
      const x1 = SIZE * (0.6 + r() * 0.35);
      g.lineWidth = 0.8 + r() * 2.5;
      g.globalAlpha = 0.5 + r() * 0.5;
      g.beginPath();
      g.moveTo(x0, y);
      g.quadraticCurveTo((x0 + x1) / 2, y + (r() - 0.5) * 18, x1, y + (r() - 0.5) * 24);
      g.stroke();
    }
    g.globalAlpha = 1;
  },
  star: (g) => {
    g.fillStyle = '#fff';
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      const rad = (i % 2 ? 0.2 : 0.46) * SIZE;
      g.lineTo(SIZE / 2 + Math.cos(a) * rad, SIZE / 2 + Math.sin(a) * rad);
    }
    g.fill();
  },
  leaf: (g) => {
    g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(SIZE * 0.5, SIZE * 0.06);
    g.bezierCurveTo(SIZE * 0.95, SIZE * 0.3, SIZE * 0.8, SIZE * 0.8, SIZE * 0.5, SIZE * 0.94);
    g.bezierCurveTo(SIZE * 0.2, SIZE * 0.8, SIZE * 0.05, SIZE * 0.3, SIZE * 0.5, SIZE * 0.06);
    g.fill();
  },
};

export const BUILTIN_TIPS: BrushTip[] = [
  { id: 'round', name: 'Round' },
  { id: 'square', name: 'Square' },
  { id: 'splatter', name: 'Splatter' },
  { id: 'grunge', name: 'Grunge' },
  { id: 'scratches', name: 'Scratches' },
  { id: 'star', name: 'Star' },
  { id: 'leaf', name: 'Leaf' },
];

const builtinTextures = new Map<string, THREE.CanvasTexture>();
const previews = new Map<string, string>();

function builtinCanvas(id: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, SIZE, SIZE);
  if (id === 'round') {
    const grad = g.createRadialGradient(SIZE / 2, SIZE / 2, SIZE * 0.25, SIZE / 2, SIZE / 2, SIZE / 2);
    grad.addColorStop(0, '#fff');
    grad.addColorStop(1, '#000');
    g.fillStyle = grad;
    g.fillRect(0, 0, SIZE, SIZE);
  } else DRAW[id]?.(g);
  return c;
}

/** Texture for a built-in tip (null for 'round', which is procedural). */
export function builtinTipTexture(id: string): THREE.Texture | null {
  if (id === 'round' || !DRAW[id]) return null;
  let t = builtinTextures.get(id);
  if (!t) {
    t = new THREE.CanvasTexture(builtinCanvas(id));
    t.colorSpace = THREE.NoColorSpace;
    t.flipY = false; // same convention as imported images: v = 0 is the top row
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    builtinTextures.set(id, t);
  }
  return t;
}

/** Small preview image (data URL) of a tip for the UI. */
export function tipPreview(tip: BrushTip, userImage?: () => string | null): string | null {
  if (tip.assetId) return userImage?.() ?? null;
  let url = previews.get(tip.id);
  if (!url) {
    url = builtinCanvas(tip.id).toDataURL();
    previews.set(tip.id, url);
  }
  return url;
}

/**
 * Normalises an imported image into a tip: greyscale, white = paint, square, ≤256 px. Images on a light
 * background (typical for brush packs) are inverted automatically.
 */
export async function importTipImage(name: string, bytes: Uint8Array): Promise<{ asset: TextureAsset; preview: string }> {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  const s = SIZE / Math.max(bmp.width, bmp.height);
  const w = bmp.width * s;
  const h = bmp.height * s;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, SIZE, SIZE);
  g.drawImage(bmp, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
  bmp.close();
  const img = g.getImageData(0, 0, SIZE, SIZE);
  const d = img.data;
  // Composite over white, then decide polarity from the border brightness.
  let border = 0;
  let n = 0;
  for (let i = 0; i < SIZE; i++)
    for (const [x, y] of [
      [i, 0],
      [i, SIZE - 1],
      [0, i],
      [SIZE - 1, i],
    ]) {
      const k = (y * SIZE + x) * 4;
      border += (d[k] + d[k + 1] + d[k + 2]) / 3;
      n++;
    }
  const invert = border / n > 127;
  for (let k = 0; k < d.length; k += 4) {
    let v = 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2];
    if (invert) v = 255 - v;
    d[k] = d[k + 1] = d[k + 2] = v;
    d[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/png'));
  const asset = await makeAsset(name.replace(/\.[^.]+$/, '') + '.png', new Uint8Array(await blob.arrayBuffer()), 'image/png');
  return { asset, preview: c.toDataURL() };
}
