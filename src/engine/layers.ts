import * as THREE from 'three';
import { clearTarget, createRT } from './gl';

export type ChannelKey = 'color' | 'roughness' | 'metallic' | 'height' | 'normal' | 'emissive' | 'opacity';
export const CHANNELS: ChannelKey[] = ['color', 'roughness', 'metallic', 'height', 'normal', 'emissive', 'opacity'];
export type ChannelSet = Record<ChannelKey, boolean>;

export interface MaterialValues {
  /** sRGB 0..1 */
  color: [number, number, number];
  roughness: number;
  metallic: number;
  /** 0..1, 0.5 = neutral */
  height: number;
  /** sRGB 0..1 (black when missing) */
  emissive?: [number, number, number];
  /** 0..1 (1 when missing) */
  opacity?: number;
}

/** Texture-backed channels of a material (ids into the TextureStore), sampled triplanar in object space. */
export interface MaterialMaps {
  color?: string;
  roughness?: string;
  metallic?: string;
  height?: string;
  /** tangent-space normal map */
  normal?: string;
  /** the normal map uses the DirectX convention (green = −Y) */
  normalDX?: boolean;
  /** the roughness map is actually a gloss/smoothness map */
  gloss?: boolean;
  /** which component (0 = R … 3 = A) to read, for packed maps such as ARM/ORM */
  channels?: { roughness?: number; metallic?: number; height?: number };
}
export const MAP_KEYS = ['color', 'roughness', 'metallic', 'height', 'normal'] as const;

export function hasMaps(m: MaterialMaps | null | undefined): m is MaterialMaps {
  return !!m && MAP_KEYS.some((k) => !!m[k]);
}

export const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'add', 'subtract'] as const;
export type BlendMode = (typeof BLEND_MODES)[number];
export const HEIGHT_BLENDS = ['add', 'normal'] as const;
export type HeightBlend = (typeof HEIGHT_BLENDS)[number];

export const GEN_TYPES = ['none', 'edge', 'dirt', 'gradient', 'noise', 'facing', 'ao', 'curvature', 'hatch'] as const;
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
  /** the library item this layer (a fill) or folder (a smart material) was added from, so it can be updated */
  source?: LayerSource;
}

export interface LayerSource {
  kind: 'material' | 'smart';
  id: string;
}

export interface PaintLayer extends LayerBase {
  kind: 'paint';
  /** MRT x5 RGBA8, layout as documented at PAINT_TARGETS */
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
  maps: MaterialMaps | null;
  /** triplanar repeats across the model's bounding box */
  tiling: number;
}

/** Folder: its children are composited onto the stack below, then blended in through the folder's mask × opacity. */
export interface GroupLayer extends LayerBase {
  kind: 'group';
  /** bottom → top, like the root list */
  children: Layer[];
  collapsed: boolean;
}

export type Layer = PaintLayer | FillLayer | GroupLayer;

/** Depth-first walk over a layer tree (parents before their children). */
export function* walkLayers(list: Layer[]): Generator<Layer> {
  for (const l of list) {
    yield l;
    if (l.kind === 'group') yield* walkLayers(l.children);
  }
}

export interface LayerLocation {
  layer: Layer;
  /** the array that contains the layer (root list or a folder's children) */
  list: Layer[];
  index: number;
  parent: GroupLayer | null;
}

export function locateLayer(list: Layer[], id: number, parent: GroupLayer | null = null): LayerLocation | null {
  for (let i = 0; i < list.length; i++) {
    const l = list[i];
    if (l.id === id) return { layer: l, list, index: i, parent };
    if (l.kind === 'group') {
      const found = locateLayer(l.children, id, l);
      if (found) return found;
    }
  }
  return null;
}

export function createGroup(name: string, children: Layer[] = []): GroupLayer {
  return { kind: 'group', id: newLayerId(), name, visible: true, opacity: 1, blend: 'normal', heightBlend: 'add', mask: null, children, collapsed: false };
}

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
    case 'hatch':
      return { ...base, amount: 0.5, contrast: 0.9, noiseScale: 60, noiseAmount: 0.1 };
    default:
      return base;
  }
}

/**
 * [0] color.rgb + a, [1] rough, roughA, metal, metalA, [2] height, heightA, opacity, opacityA,
 * [3] normal.xy (0.5 = flat), normalA, [4] emissive.rgb + a
 */
export const PAINT_TARGETS = 5;
export function createPaintRT(size: number): THREE.WebGLRenderTarget {
  return createRT(size, size, { count: PAINT_TARGETS });
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
    // Normal is opt-in: a fill without a normal map would otherwise flatten the details below it.
    channels: { color: true, roughness: true, metallic: true, height: true, normal: false, emissive: false, opacity: false, ...channels },
    variation: 0,
    variationScale: 6,
    seed: Math.random() * 100,
    maps: null,
    tiling: 4,
  };
}

export function disposeLayer(l: Layer) {
  if (l.kind === 'paint') l.rt.dispose();
  if (l.kind === 'group') l.children.forEach(disposeLayer);
  l.mask?.rt.dispose();
}
