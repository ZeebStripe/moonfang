/** Mask generator definitions. Kept free of WebGL imports so they can be unit tested in Node. */

// New generators go at the end: the shader selects them by index.
export const GEN_TYPES = [
  'none', 'edge', 'dirt', 'gradient', 'noise', 'facing', 'ao', 'curvature', 'hatch',
  'pores', 'freckles', 'blush', 'iris', 'pupil', 'limbal', 'eyeveins',
] as const;
export type GenType = (typeof GEN_TYPES)[number];
export const GEN_LABELS: Record<GenType, string> = {
  none: 'None',
  edge: 'Edge Wear',
  dirt: 'Dirt / Cavity',
  gradient: 'Position Gradient',
  noise: 'Noise',
  facing: 'Top Facing (Dust)',
  ao: 'Ambient Occlusion',
  curvature: 'Curvature',
  hatch: 'Hatching (shadows)',
  pores: 'Skin Pores',
  freckles: 'Freckles',
  blush: 'Blush (convex areas)',
  iris: 'Eye: Iris Fibers',
  pupil: 'Eye: Pupil',
  limbal: 'Eye: Limbal Ring',
  eyeveins: 'Eye: Veins',
};

export interface GeneratorParams {
  type: GenType;
  /** coverage threshold 0..1 */
  amount: number;
  /** edge sharpness 0..1 */
  contrast: number;
  noiseScale: number;
  /** how much noise breaks up the signal 0..1 */
  noiseAmount: number;
  invert: boolean;
  /** 0-2 = +X/+Y/+Z; eye generators also take 3-5 = -X/-Y/-Z as the look direction */
  axis: 0 | 1 | 2 | 3 | 4 | 5;
  seed: number;
  /**
   * Eye generators only. 'sphere' centres the iris where the surface faces the look axis, so it stays round on every
   * eyeball whatever its UVs; 'uv' expects a texture laid out as a disc centred in the 0-1 square. Missing = 'uv'.
   */
  mapping?: 'sphere' | 'uv';
  /**
   * Eye generators only: moves the centre, x right and y up as seen looking at the eye. With sphere mapping it turns
   * the gaze (0.5 = 60°), with UV mapping it shifts the disc in UV units. Missing = [0, 0].
   */
  offset?: [number, number];
}

export const EYE_GENERATORS: readonly GenType[] = ['iris', 'pupil', 'limbal', 'eyeveins'];
/** Look directions for sphere-mapped eye generators, as `axis` values. */
export const LOOK_AXES = [[2, '+Z (front)'], [5, '−Z (back)'], [0, '+X'], [3, '−X'], [1, '+Y'], [4, '−Y']] as const;

export function defaultGenerator(type: GenType): GeneratorParams {
  const base: GeneratorParams = { type, amount: 0.5, contrast: 0.5, noiseScale: 8, noiseAmount: 0.3, invert: false, axis: 1, seed: Math.random() * 100 };
  const eye: GeneratorParams = { ...base, axis: 2, mapping: 'sphere' };
  switch (type) {
    case 'edge':
      return { ...base, amount: 0.35, contrast: 0.6, noiseScale: 12, noiseAmount: 0.45 };
    case 'dirt':
      return { ...base, amount: 0.45, contrast: 0.4, noiseScale: 6, noiseAmount: 0.35 };
    case 'gradient':
      return { ...base, amount: 0.4, contrast: 0.3, noiseAmount: 0.15 };
    case 'noise':
      return { ...base, amount: 0.5, contrast: 0.6, noiseScale: 5 };
    case 'facing':
      return { ...base, amount: 0.4, contrast: 0.5, noiseAmount: 0.3 };
    case 'hatch':
      return { ...base, amount: 0.5, contrast: 0.9, noiseScale: 60, noiseAmount: 0.1 };
    case 'pores':
      return { ...base, amount: 0.5, contrast: 0.6, noiseScale: 320, noiseAmount: 0.1 };
    case 'freckles':
      return { ...base, amount: 0.25, contrast: 0.7, noiseScale: 160, noiseAmount: 0.3 };
    case 'blush':
      return { ...base, amount: 0.35, contrast: 0, noiseScale: 2.5, noiseAmount: 0 };
    case 'iris':
      // amount = iris radius (0.5 = 60 degrees from the look axis, or the edge of the UV square), contrast = edge
      // softness, noiseScale = fiber count, noiseAmount = fiber strength
      return { ...eye, amount: 0.3, contrast: 0.85, noiseScale: 60, noiseAmount: 0.45 };
    case 'pupil':
      return { ...eye, amount: 0.1, contrast: 0.9, noiseScale: 4, noiseAmount: 0 };
    case 'limbal':
      return { ...eye, amount: 0.3, contrast: 0.5, noiseScale: 6, noiseAmount: 0.15 };
    case 'eyeveins':
      return { ...eye, amount: 0.3, contrast: 0.6, noiseScale: 40, noiseAmount: 0.5 };
    default:
      return base;
  }
}
