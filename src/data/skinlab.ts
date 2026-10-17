import type { SmartLayerSpec, SmartMaterial } from './materials';

/**
 * Skin Lab: turns a few intuitive parameters (skin tone, freckles, iris colour, …) into a smart material, which the
 * app adds as an ordinary folder of fill layers. Everything here is pure data, so it is unit tested without a browser.
 */

type RGB = [number, number, number];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mixRgb = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const scaleRgb = (c: RGB, k: number): RGB => [clamp01(c[0] * k), clamp01(c[1] * k), clamp01(c[2] * k)];
const css = (c: RGB) => `rgb(${c.map((v) => Math.round(clamp01(v) * 255)).join(',')})`;

/** Skin tones from very light to very deep (sRGB), sampled by `melanin`. */
const TONE_RAMP: RGB[] = [
  [0.97, 0.86, 0.8],
  [0.9, 0.75, 0.65],
  [0.8, 0.62, 0.49],
  [0.64, 0.46, 0.34],
  [0.47, 0.31, 0.21],
  [0.27, 0.17, 0.12],
];

/**
 * Base skin colour (sRGB 0..1). `melanin` 0 = very light … 1 = very deep; `undertone` −1 = cool/pink … +1 = warm/golden.
 */
export function skinTone(melanin: number, undertone = 0): RGB {
  const t = clamp01(melanin) * (TONE_RAMP.length - 1);
  const i = Math.min(TONE_RAMP.length - 2, Math.floor(t));
  const base = mixRgb(TONE_RAMP[i], TONE_RAMP[i + 1], t - i);
  const u = Math.max(-1, Math.min(1, undertone));
  // Cool: a little more red and blue. Warm: a little more green, less blue.
  const shift: RGB = u < 0 ? [0.03 * -u, -0.012 * -u, 0.03 * -u] : [-0.01 * u, 0.012 * u, -0.04 * u];
  return [clamp01(base[0] + shift[0]), clamp01(base[1] + shift[1]), clamp01(base[2] + shift[2])];
}

export interface SkinParams {
  /** 0 = very light … 1 = very deep */
  melanin: number;
  /** −1 = cool … +1 = warm */
  undertone: number;
  /** blush and ruddiness on cheeks, nose and brow, 0..1 */
  redness: number;
  /** 0 = none … 1 = heavy */
  freckles: number;
  /** add pore relief; off by default until it reads right */
  poresOn: boolean;
  /** pore relief depth, 0..1 */
  pores: number;
  /** surface shine, 0 = matte … 1 = oily */
  oiliness: number;
  /** dirt, oil, … coats painted over the skin, bottom → top */
  grime: GrimeCoat[];
}

export const DEFAULT_SKIN: SkinParams = { melanin: 0.3, undertone: 0.2, redness: 0.35, freckles: 0.15, poresOn: false, pores: 0.5, oiliness: 0.1, grime: [] };

export const SKIN_PRESETS: { name: string; params: Partial<SkinParams> }[] = [
  { name: 'Porcelain', params: { melanin: 0.03, undertone: -0.5, redness: 0.4, freckles: 0.1 } },
  { name: 'Fair', params: { melanin: 0.15, undertone: -0.1, redness: 0.4, freckles: 0.3 } },
  { name: 'Olive', params: { melanin: 0.4, undertone: 0.6, redness: 0.25, freckles: 0 } },
  { name: 'Tan', params: { melanin: 0.55, undertone: 0.4, redness: 0.25, freckles: 0.05 } },
  { name: 'Brown', params: { melanin: 0.75, undertone: 0.2, redness: 0.2, freckles: 0 } },
  { name: 'Deep', params: { melanin: 0.95, undertone: 0, redness: 0.15, freckles: 0 } },
];

/** Where a grime coat collects: in cavities and creases, in blotchy patches, as spatters, or on upward faces. */
export type GrimePattern = 'cavities' | 'patches' | 'splatter' | 'top';

export const GRIME_PATTERNS: readonly (readonly [GrimePattern, string])[] = [
  ['cavities', 'Cavities & creases'],
  ['patches', 'Patches'],
  ['splatter', 'Splatter'],
  ['top', 'Top surfaces'],
];

/** One coat of grime. Coats stack in order, each one a fill layer over the skin and the coats below it. */
export interface GrimeCoat {
  name: string;
  color: RGB;
  /** coverage, 0 = none … 1 = caked on */
  amount: number;
  /** 0 = matte (dust, dry dirt) … 1 = glossy (oil, wet mud) */
  smoothness: number;
  pattern: GrimePattern;
  /** changes the pattern's placement; coats with different seeds land in different spots */
  seed: number;
}

export const GRIME_PRESETS: Omit<GrimeCoat, 'seed'>[] = [
  { name: 'Dirt', color: [0.3, 0.22, 0.14], amount: 0.5, smoothness: 0.1, pattern: 'cavities' },
  { name: 'Mud', color: [0.33, 0.25, 0.16], amount: 0.45, smoothness: 0.45, pattern: 'patches' },
  { name: 'Motor Oil', color: [0.045, 0.038, 0.03], amount: 0.4, smoothness: 0.9, pattern: 'patches' },
  { name: 'Soot', color: [0.05, 0.045, 0.04], amount: 0.4, smoothness: 0.05, pattern: 'cavities' },
  { name: 'Dust', color: [0.64, 0.6, 0.53], amount: 0.4, smoothness: 0, pattern: 'top' },
  { name: 'Blood', color: [0.33, 0.03, 0.03], amount: 0.35, smoothness: 0.65, pattern: 'splatter' },
];

/** A new coat from a preset, with a seed that differs from the coats already in `stack`. */
export function grimeCoat(preset: string, stack: GrimeCoat[] = []): GrimeCoat {
  const base = GRIME_PRESETS.find((p) => p.name === preset) ?? GRIME_PRESETS[0];
  return { ...base, color: [...base.color] as RGB, seed: 101 + stack.length * 17.3 };
}

/** The mask generator for a coat: `amount` drives the coverage threshold of its pattern. */
function grimeGenerator(c: GrimeCoat): NonNullable<SmartLayerSpec['generator']> {
  const a = clamp01(c.amount);
  switch (c.pattern) {
    case 'patches':
      return { type: 'noise', amount: lerp(0.2, 0.8, a), contrast: 0.78, noiseScale: 3, noiseAmount: 0, seed: c.seed };
    case 'splatter':
      return { type: 'noise', amount: lerp(0.15, 0.55, a), contrast: 0.9, noiseScale: 14, noiseAmount: 0, seed: c.seed };
    case 'top':
      return { type: 'facing', amount: lerp(0.1, 0.7, a), contrast: 0.5, noiseScale: 8, noiseAmount: 0.35, seed: c.seed };
    default:
      return { type: 'dirt', amount: lerp(0.15, 0.8, a), contrast: 0.4, noiseScale: 6, noiseAmount: 0.4, seed: c.seed };
  }
}

/** Grime coats as fill layers (bottom → top), skipping empty ones. Names get a number when a kind repeats. */
export function grimeLayers(coats: GrimeCoat[], taken: string[] = []): SmartLayerSpec[] {
  const used = new Set(taken);
  const layers: SmartLayerSpec[] = [];
  for (const c of coats) {
    if (c.amount <= 0.01) continue;
    let name = c.name || 'Grime';
    for (let i = 2; used.has(name); i++) name = `${c.name || 'Grime'} ${i}`;
    used.add(name);
    layers.push({
      name,
      values: { color: c.color, roughness: lerp(0.95, 0.05, clamp01(c.smoothness)), metallic: 0, height: 0.5 },
      channels: { metallic: false, height: false },
      // Thin coats are see-through; from a third coverage up they hide the skin completely.
      opacity: Math.min(1, 0.5 + clamp01(c.amount) * 1.5),
      generator: grimeGenerator(c),
    });
  }
  return layers;
}

/** Grime coats on their own, as a folder to put over any layers (armour, clothes, an existing skin). */
export function buildGrimeMaterial(coats: GrimeCoat[]): SmartMaterial {
  return { id: 'skinlab_grime', name: 'Skin Lab Grime', preview: grimePreview('#777', coats), layers: grimeLayers(coats) };
}

/** Shelf / dialog preview: a few blotches of each coat over `under`. */
function grimePreview(under: string, coats: GrimeCoat[]): string {
  const spots = coats
    .filter((c) => c.amount > 0.01)
    .flatMap((c, i) => {
      const a = (0.45 + c.amount * 0.55).toFixed(2);
      const rgba = `rgba(${c.color.map((v) => Math.round(clamp01(v) * 255)).join(',')},${a})`;
      const r = Math.round(4 + c.amount * 8);
      return [0, 1].map((k) => `radial-gradient(circle at ${(17 + i * 23 + k * 41) % 90 + 5}% ${(30 + i * 29 + k * 37) % 80 + 10}%, ${rgba} 0 ${r}%, transparent ${r + 3}%)`);
    });
  return [...spots, under].join(', ');
}

/** The skin as a smart material: tone, blush, recess shading, freckles (skipped when negligible) and pore relief (when enabled). */
export function buildSkinMaterial(input: Partial<SkinParams> = {}): SmartMaterial {
  const p: SkinParams = { ...DEFAULT_SKIN, ...input };
  const base = skinTone(p.melanin, p.undertone);
  const blush = mixRgb(base, [0.86, 0.3, 0.3], 0.4);
  const shadow = scaleRgb(mixRgb(base, [0.5, 0.2, 0.2], 0.4), 0.7);
  const freckle = scaleRgb(mixRgb(base, [0.62, 0.32, 0.16], 0.6), 0.85);
  const roughness = lerp(0.62, 0.3, clamp01(p.oiliness));

  const layers: SmartLayerSpec[] = [
    {
      name: 'Skin Tone',
      values: { color: base, roughness, metallic: 0, height: 0.5 },
      channels: { height: false },
      variation: 0.05,
      variationScale: 16,
    },
    {
      name: 'Blush',
      values: { color: blush, roughness, metallic: 0, height: 0.5 },
      channels: { roughness: false, metallic: false, height: false },
      // Gentle and soft-edged: a full-strength, hard-edged blush leaves pale bands in every crease of a body.
      opacity: clamp01(p.redness) * 0.6,
      generator: { type: 'blush', amount: 0.35, contrast: 0, noiseScale: 2.5, noiseAmount: 0 },
    },
    {
      name: 'Recess Shading',
      values: { color: shadow, roughness, metallic: 0, height: 0.5 },
      channels: { roughness: false, metallic: false, height: false },
      blend: 'multiply',
      // Occlusion, not the dirt generator: dirt adds concave curvature, which saturates on organic game meshes and
      // paints hard dark bands along the neck and blotches under the eyes. Occlusion is smooth and darkest in real creases.
      opacity: 0.65,
      generator: { type: 'ao', amount: 0.6, contrast: 0, noiseScale: 5, noiseAmount: 0.05 },
    },
  ];
  if (p.freckles > 0.01) {
    layers.push({
      name: 'Freckles',
      values: { color: freckle, roughness, metallic: 0, height: 0.5 },
      channels: { roughness: false, metallic: false, height: false },
      opacity: clamp01(p.freckles),
      generator: { type: 'freckles', amount: lerp(0.15, 0.4, clamp01(p.freckles)), contrast: 0.7, noiseScale: 160, noiseAmount: 0.3 },
    });
  }
  if (p.poresOn) layers.push({
    name: 'Pores',
    // Shallow and fine: scales are relative to the model's size, and on a full body (where one texel is a few mm)
    // deeper or larger pits read as craters.
    values: { color: base, roughness: Math.min(1, roughness + 0.15), metallic: 0, height: 0.47 },
    channels: { color: false, metallic: false },
    opacity: clamp01(p.pores),
    generator: { type: 'pores', amount: 0.5, contrast: 0.6, noiseScale: 320, noiseAmount: 0.1 },
  });
  layers.push(...grimeLayers(p.grime, layers.map((l) => l.name)));

  return {
    id: 'skinlab_skin',
    name: 'Skin Lab Skin',
    preview: grimePreview(`radial-gradient(circle at 35% 30%, ${css(scaleRgb(base, 1.08))} 0 45%, ${css(base)} 46% 70%, ${css(blush)} 71%)`, p.grime),
    layers,
  };
}

export interface EyeParams {
  iris: RGB;
  /** iris radius, 0.15..0.45 (0.5 = 60° from the look axis with sphere mapping, or the edge of the UV square) */
  irisRadius: number;
  /** pupil radius in the same units, 0.03..0.2 */
  pupilRadius: number;
  /** dark ring around the iris, 0..1 */
  limbal: number;
  /** bloodshot veins on the sclera, 0..1 */
  veins: number;
  /** strength of the iris fibres, 0..1 */
  fibers: number;
  /** 'sphere': the iris faces `axis` on a round eyeball, whatever its UVs. 'uv': a disc centred in the UV square. */
  mapping: 'sphere' | 'uv';
  /** look direction for sphere mapping: 0-2 = +X/+Y/+Z, 3-5 = -X/-Y/-Z */
  axis: 0 | 1 | 2 | 3 | 4 | 5;
  /** where the whole eye looks, x right / y up seen looking at it, -0.5..0.5 (see GeneratorParams.offset) */
  gaze: [number, number];
  /** the pupil's shift inside the iris, same units; kept inside the iris */
  pupilOffset: [number, number];
}

export const DEFAULT_EYE: EyeParams = {
  iris: [0.2, 0.4, 0.62], irisRadius: 0.3, pupilRadius: 0.1, limbal: 0.7, veins: 0.15, fibers: 0.8, mapping: 'sphere', axis: 2, gaze: [0, 0], pupilOffset: [0, 0],
};

export const EYE_PRESETS: { name: string; iris: RGB }[] = [
  { name: 'Brown', iris: [0.32, 0.18, 0.08] },
  { name: 'Hazel', iris: [0.46, 0.34, 0.14] },
  { name: 'Green', iris: [0.24, 0.45, 0.22] },
  { name: 'Blue', iris: [0.2, 0.4, 0.62] },
  { name: 'Gray', iris: [0.46, 0.5, 0.54] },
  { name: 'Amber', iris: [0.7, 0.45, 0.1] },
];

/** CSS eye drawn to scale (r = 0.5 is 36px, half the Skin Lab preview's height), so size and offset changes show. */
function eyePreview(irisR: number, pupilR: number, iris: [number, number], pupil: [number, number], dark: RGB, color: RGB): string {
  const px = (r: number) => `${(r * 72).toFixed(1)}px`;
  const at = (o: [number, number]) => `at calc(50% + ${px(o[0])}) calc(50% - ${px(o[1])})`;
  return [
    `radial-gradient(circle ${px(pupilR)} ${at(pupil)}, #050505 92%, transparent 100%)`,
    `radial-gradient(circle ${px(irisR)} ${at(iris)}, ${css(dark)} 0 30%, ${css(color)} 45% 86%, #0a0b0c 90% 96%, transparent 100%)`,
    '#efebe3',
  ].join(', ');
}

export function buildEyeMaterial(input: Partial<EyeParams> = {}): SmartMaterial {
  const p: EyeParams = { ...DEFAULT_EYE, ...input };
  const irisRadius = Math.min(0.45, Math.max(0.15, p.irisRadius));
  const pupilRadius = Math.min(irisRadius * 0.8, Math.max(0.03, p.pupilRadius));
  const wet = { roughness: 0.18, metallic: 0, height: 0.5 };
  const dark = scaleRgb(p.iris, 0.5);
  const light = mixRgb(scaleRgb(p.iris, 1.5), [1, 1, 1], 0.1);
  const lim = (v: number, m: number) => Math.min(m, Math.max(-m, v || 0));
  // Gaze up to 60° (0.5): further turns the iris round the side of the eyeball.
  const gaze: [number, number] = [lim(p.gaze[0], 0.5), lim(p.gaze[1], 0.5)];
  // The pupil stays inside the iris: its shift is limited to the gap between their radii.
  const room = irisRadius - pupilRadius;
  const po = p.pupilOffset;
  const k = Math.hypot(po[0], po[1]) > room ? room / Math.hypot(po[0], po[1]) : 1;
  const pupilAt: [number, number] = [gaze[0] + (po[0] || 0) * k, gaze[1] + (po[1] || 0) * k];
  const map = { mapping: p.mapping, axis: p.axis, offset: gaze };

  const layers: SmartLayerSpec[] = [
    { name: 'Sclera', values: { color: [0.94, 0.92, 0.89], ...wet }, channels: { height: false, metallic: false } },
  ];
  if (p.veins > 0.01) {
    layers.push({
      name: 'Veins',
      values: { color: [0.72, 0.16, 0.16], ...wet },
      channels: { roughness: false, metallic: false, height: false },
      opacity: clamp01(p.veins),
      generator: { ...map, type: 'eyeveins', amount: 0.3, contrast: 0.6, noiseScale: 40, noiseAmount: 0.5 },
    });
  }
  layers.push(
    {
      name: 'Iris',
      values: { color: p.iris, ...wet, roughness: 0.3 },
      channels: { height: false, metallic: false },
      generator: { ...map, type: 'iris', amount: irisRadius, contrast: 0.85, noiseScale: 60, noiseAmount: 0 },
    },
    {
      name: 'Iris Fibers (dark)',
      values: { color: dark, ...wet },
      channels: { roughness: false, metallic: false, height: false },
      opacity: clamp01(p.fibers) * 0.85,
      generator: { ...map, type: 'iris', amount: irisRadius, contrast: 0.85, noiseScale: 70, noiseAmount: 1, seed: 11 },
    },
    {
      name: 'Iris Fibers (light)',
      values: { color: light, ...wet },
      channels: { roughness: false, metallic: false, height: false },
      opacity: clamp01(p.fibers) * 0.5,
      generator: { ...map, type: 'iris', amount: irisRadius, contrast: 0.85, noiseScale: 45, noiseAmount: 1, seed: 37 },
    },
    {
      name: 'Limbal Ring',
      values: { color: [0.03, 0.04, 0.05], ...wet },
      channels: { roughness: false, metallic: false, height: false },
      opacity: clamp01(p.limbal),
      generator: { ...map, type: 'limbal', amount: irisRadius, contrast: 0.5, noiseScale: 6, noiseAmount: 0.15 },
    },
    {
      name: 'Pupil',
      values: { color: [0.01, 0.01, 0.012], ...wet },
      channels: { height: false, metallic: false },
      generator: { ...map, offset: pupilAt, type: 'pupil', amount: pupilRadius, contrast: 0.9, noiseScale: 4, noiseAmount: 0 },
    },
  );

  return {
    id: 'skinlab_eye',
    name: 'Skin Lab Eye',
    preview: eyePreview(irisRadius, pupilRadius, gaze, pupilAt, dark, p.iris),
    layers,
  };
}
