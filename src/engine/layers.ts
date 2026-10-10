import * as THREE from 'three';
import { clearTarget, createRT } from './gl';

export type ChannelKey = 'color' | 'roughness' | 'metallic' | 'height';
export const CHANNELS: ChannelKey[] = ['color', 'roughness', 'metallic', 'height'];
export type ChannelSet = Record<ChannelKey, boolean>;

export interface MaterialValues {
  /** sRGB 0..1 */
  color: [number, number, number];
  roughness: number;
  metallic: number;
  /** 0..1, 0.5 = neutral */
  height: number;
}

export const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'add', 'subtract'] as const;
export type BlendMode = (typeof BLEND_MODES)[number];
export const HEIGHT_BLENDS = ['add', 'normal'] as const;
export type HeightBlend = (typeof HEIGHT_BLENDS)[number];

export const GEN_TYPES = ['none', 'edge', 'dirt', 'gradient', 'noise', 'facing', 'ao', 'curvature'] as const;
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
  axis: 0 | 1 | 2;
  seed: number;
}

export interface LayerMask {
  rt: THREE.WebGLRenderTarget;
  generator: GeneratorParams | null;
  enabled: boolean;
}

interface LayerBase {
  id: number;
  name: string;
  visible: boolean;
  opacity: number;
  blend: BlendMode;
  heightBlend: HeightBlend;
  mask: LayerMask | null;
}

export interface PaintLayer extends LayerBase {
  kind: 'paint';
  /** MRT x3 RGBA8: [0] color.rgb + alpha, [1] rough, roughA, metal, metalA, [2] height, heightA */
  rt: THREE.WebGLRenderTarget;
}

export interface FillLayer extends LayerBase {
  kind: 'fill';
  values: MaterialValues;
  channels: ChannelSet;
  /** procedural value variation 0..1 */
  variation: number;
  variationScale: number;
  seed: number;
}

export type Layer = PaintLayer | FillLayer;

let nextId = 1;
export function newLayerId() {
  return nextId++;
}
export function bumpLayerId(min: number) {
  nextId = Math.max(nextId, min + 1);
}

export function defaultGenerator(type: GenType): GeneratorParams {
  const base: GeneratorParams = { type, amount: 0.5, contrast: 0.5, noiseScale: 8, noiseAmount: 0.3, invert: false, axis: 1, seed: Math.random() * 100 };
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
    default:
      return base;
  }
}

export function createPaintRT(size: number): THREE.WebGLRenderTarget {
  return createRT(size, size, { count: 3 });
}

export function createMaskRT(renderer: THREE.WebGLRenderer, size: number, value: number): THREE.WebGLRenderTarget {
  const rt = createRT(size, size, { linear: true });
  clearTarget(renderer, rt, value, value, value, 1);
  return rt;
}

export function createPaintLayer(renderer: THREE.WebGLRenderer, size: number, name = 'Paint Layer'): PaintLayer {
  const rt = createPaintRT(size);
  clearTarget(renderer, rt, 0, 0, 0, 0);
  return { kind: 'paint', id: newLayerId(), name, visible: true, opacity: 1, blend: 'normal', heightBlend: 'add', mask: null, rt };
}

export function createFillLayer(name: string, values: MaterialValues, channels?: Partial<ChannelSet>): FillLayer {
  return {
    kind: 'fill',
    id: newLayerId(),
    name,
    visible: true,
    opacity: 1,
    blend: 'normal',
    heightBlend: 'add',
    mask: null,
    values: { ...values, color: [...values.color] as [number, number, number] },
    channels: { color: true, roughness: true, metallic: true, height: true, ...channels },
    variation: 0,
    variationScale: 6,
    seed: Math.random() * 100,
  };
}

export function disposeLayer(l: Layer) {
  if (l.kind === 'paint') l.rt.dispose();
  l.mask?.rt.dispose();
}
