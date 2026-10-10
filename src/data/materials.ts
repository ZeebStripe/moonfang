import type { ChannelSet, GeneratorParams, BlendMode, HeightBlend, MaterialMaps, MaterialValues } from '../engine/layers';

export interface MaterialPreset {
  id: string;
  name: string;
  category: 'Metal' | 'Paint' | 'Organic' | 'Synthetic' | 'Mineral' | 'Grime' | 'Custom';
  values: MaterialValues;
  variation?: number;
  /** optional texture maps (user materials) */
  maps?: MaterialMaps;
  tiling?: number;
  /** user-created / imported (lives in the library, can be deleted) */
  custom?: boolean;
}

const m = (
  id: string,
  name: string,
  category: MaterialPreset['category'],
  color: [number, number, number],
  roughness: number,
  metallic: number,
  height = 0.5,
  variation = 0,
): MaterialPreset => ({ id, name, category, values: { color, roughness, metallic, height }, variation });

/** Base colors are sRGB; metal colors follow measured F0 values. */
export const MATERIALS: MaterialPreset[] = [
  m('iron', 'Iron Raw', 'Metal', [0.56, 0.57, 0.58], 0.48, 1, 0.5, 0.15),
  m('steel', 'Steel Polished', 'Metal', [0.77, 0.78, 0.78], 0.18, 1),
  m('aluminium', 'Aluminium', 'Metal', [0.91, 0.92, 0.92], 0.32, 1),
  m('chrome', 'Chrome', 'Metal', [0.55, 0.56, 0.56], 0.05, 1),
  m('gold', 'Gold', 'Metal', [1.0, 0.78, 0.34], 0.22, 1),
  m('copper', 'Copper', 'Metal', [0.95, 0.64, 0.54], 0.28, 1),
  m('brass', 'Brass', 'Metal', [0.91, 0.78, 0.42], 0.3, 1),
  m('blackmetal', 'Gunmetal', 'Metal', [0.24, 0.24, 0.26], 0.38, 1),
  m('paint_red', 'Paint Red', 'Paint', [0.62, 0.07, 0.05], 0.38, 0),
  m('paint_yellow', 'Paint Yellow', 'Paint', [0.88, 0.62, 0.06], 0.42, 0),
  m('paint_green', 'Paint Military', 'Paint', [0.27, 0.31, 0.19], 0.58, 0),
  m('paint_blue', 'Paint Blue', 'Paint', [0.08, 0.2, 0.48], 0.4, 0),
  m('paint_white', 'Paint White', 'Paint', [0.86, 0.86, 0.84], 0.45, 0),
  m('plastic_white', 'Plastic White', 'Synthetic', [0.84, 0.84, 0.82], 0.32, 0),
  m('plastic_black', 'Plastic Black', 'Synthetic', [0.04, 0.04, 0.045], 0.36, 0),
  m('plastic_orange', 'Plastic Orange', 'Synthetic', [0.9, 0.35, 0.05], 0.4, 0),
  m('rubber', 'Rubber', 'Synthetic', [0.07, 0.07, 0.07], 0.88, 0),
  m('leather', 'Leather', 'Organic', [0.32, 0.17, 0.08], 0.62, 0, 0.5, 0.35),
  m('wood', 'Wood Varnish', 'Organic', [0.46, 0.27, 0.13], 0.35, 0, 0.5, 0.4),
  m('bone', 'Bone', 'Organic', [0.84, 0.79, 0.66], 0.52, 0, 0.5, 0.25),
  m('concrete', 'Concrete', 'Mineral', [0.55, 0.54, 0.5], 0.9, 0, 0.5, 0.45),
  m('stone', 'Stone Dark', 'Mineral', [0.3, 0.29, 0.28], 0.8, 0, 0.5, 0.5),
  m('rust', 'Rust', 'Grime', [0.43, 0.19, 0.08], 0.88, 0, 0.56, 0.45),
  m('dirt', 'Dirt', 'Grime', [0.24, 0.18, 0.12], 0.95, 0, 0.5, 0.3),
  m('dust', 'Dust', 'Grime', [0.62, 0.58, 0.52], 1, 0, 0.5, 0.2),
  m('soot', 'Soot', 'Grime', [0.05, 0.045, 0.04], 0.9, 0, 0.5, 0.2),
  m('verdigris', 'Verdigris', 'Grime', [0.32, 0.62, 0.52], 0.78, 0, 0.53, 0.35),
];


export interface SmartLayerSpec {
  name: string;
  /** preset id the layer starts from (optional when `values` is complete) */
  material?: string;
  channels?: Partial<ChannelSet>;
  /** override values of the preset */
  values?: Partial<MaterialValues>;
  maps?: MaterialMaps;
  tiling?: number;
  variation?: number;
  variationScale?: number;
  opacity?: number;
  blend?: BlendMode;
  heightBlend?: HeightBlend;
  generator?: Partial<GeneratorParams> & Pick<GeneratorParams, 'type'>;
}

export interface SmartMaterial {
  id: string;
  name: string;
  /** CSS background for the shelf tile */
  preview: string;
  layers: SmartLayerSpec[];
  custom?: boolean;
}

export const SMART_MATERIALS: SmartMaterial[] = [
  {
    id: 'worn_paint',
    name: 'Worn Painted Steel',
    preview: 'radial-gradient(circle at 35% 30%, #c43b2c 0 45%, #8a8d90 46% 52%, #7c2016 53%)',
    layers: [
      { name: 'Steel', material: 'iron', variation: 0.15 },
      {
        name: 'Paint',
        material: 'paint_red',
        values: { height: 0.56 },
        variation: 0.08,
        generator: { type: 'edge', invert: true, amount: 0.22, contrast: 0.75, noiseAmount: 0.55, noiseScale: 14 },
      },
      { name: 'Dirt', material: 'dirt', opacity: 0.8, channels: { height: false, metallic: false }, generator: { type: 'dirt', amount: 0.42 } },
    ],
  },
  {
    id: 'military',
    name: 'Military Paint',
    preview: 'radial-gradient(circle at 35% 30%, #59633f 0 50%, #9c9c98 51% 55%, #3a3f28 56%)',
    layers: [
      { name: 'Gunmetal', material: 'blackmetal' },
      {
        name: 'Paint',
        material: 'paint_green',
        values: { height: 0.55 },
        variation: 0.12,
        generator: { type: 'edge', invert: true, amount: 0.22, contrast: 0.7, noiseAmount: 0.6 },
      },
      { name: 'Dust', material: 'dust', opacity: 0.7, channels: { height: false, metallic: false }, generator: { type: 'facing', amount: 0.35 } },
      { name: 'Grime', material: 'dirt', opacity: 0.7, channels: { height: false, metallic: false }, generator: { type: 'dirt', amount: 0.4 } },
    ],
  },
  {
    id: 'rusty_iron',
    name: 'Rusty Iron',
    preview: 'radial-gradient(circle at 35% 30%, #8f5a3a 0 30%, #6b3216 31% 60%, #4a4c4f 61%)',
    layers: [
      { name: 'Iron', material: 'iron', variation: 0.2 },
      { name: 'Rust Patches', material: 'rust', generator: { type: 'noise', amount: 0.5, contrast: 0.55, noiseScale: 2.5 } },
      { name: 'Rust Cavities', material: 'rust', values: { color: [0.36, 0.15, 0.06] }, generator: { type: 'dirt', amount: 0.6, contrast: 0.45, noiseAmount: 0.7, noiseScale: 5 } },
      { name: 'Rust Spots', material: 'rust', values: { color: [0.3, 0.11, 0.04] }, generator: { type: 'noise', amount: 0.3, contrast: 0.8, noiseScale: 11 } },
      { name: 'Polished Edges', material: 'steel', opacity: 0.7, channels: { height: false }, generator: { type: 'edge', amount: 0.25, contrast: 0.6 } },
    ],
  },
  {
    id: 'weathered_copper',
    name: 'Weathered Copper',
    preview: 'radial-gradient(circle at 35% 30%, #d99a7c 0 30%, #7a4a35 31% 62%, #4f9e86 63%)',
    layers: [
      { name: 'Copper', material: 'copper', variation: 0.1 },
      {
        name: 'Oxide',
        material: 'copper',
        values: { color: [0.45, 0.24, 0.17], roughness: 0.55 },
        opacity: 0.85,
        generator: { type: 'noise', amount: 0.55, contrast: 0.35, noiseScale: 3 },
      },
      { name: 'Verdigris', material: 'verdigris', generator: { type: 'dirt', amount: 0.5, noiseAmount: 0.5 } },
      { name: 'Verdigris Top', material: 'verdigris', opacity: 0.8, generator: { type: 'facing', amount: 0.25, noiseAmount: 0.5 } },
    ],
  },
  {
    id: 'scuffed_plastic',
    name: 'Scuffed Plastic',
    preview: 'radial-gradient(circle at 35% 30%, #ff8a3d 0 45%, #f0b080 46% 52%, #c4500e 53%)',
    layers: [
      { name: 'Plastic', material: 'plastic_orange', variation: 0.06 },
      {
        name: 'Scuffs',
        material: 'plastic_orange',
        values: { color: [0.96, 0.7, 0.52], roughness: 0.62 },
        opacity: 0.75,
        channels: { height: false },
        generator: { type: 'edge', amount: 0.3, noiseAmount: 0.6 },
      },
      { name: 'Grime', material: 'dirt', opacity: 0.55, channels: { height: false }, generator: { type: 'dirt', amount: 0.38 } },
    ],
  },
  {
    id: 'gold_ornament',
    name: 'Antique Gold',
    preview: 'radial-gradient(circle at 35% 30%, #ffe08a 0 30%, #c79a3c 31% 62%, #4d3a1a 63%)',
    layers: [
      { name: 'Gold', material: 'gold', variation: 0.1 },
      { name: 'Tarnish', material: 'brass', values: { color: [0.55, 0.42, 0.22], roughness: 0.5 }, opacity: 0.8, generator: { type: 'noise', amount: 0.45, contrast: 0.3 } },
      { name: 'Grime', material: 'soot', channels: { height: false }, generator: { type: 'dirt', amount: 0.45 } },
      { name: 'Polish', material: 'gold', values: { roughness: 0.08 }, channels: { color: false, metallic: false, height: false }, generator: { type: 'edge', amount: 0.35 } },
    ],
  },
  {
    id: 'dusty_concrete',
    name: 'Dusty Concrete',
    preview: 'radial-gradient(circle at 35% 30%, #c8c3b8 0 30%, #8b8a84 31% 65%, #4f4d48 66%)',
    layers: [
      { name: 'Concrete', material: 'concrete', variation: 0.45, variationScale: 12 },
      { name: 'Stains', material: 'stone', opacity: 0.6, channels: { height: false }, generator: { type: 'gradient', axis: 1, invert: true, amount: 0.35, noiseAmount: 0.5 } },
      { name: 'Cavity Dirt', material: 'dirt', opacity: 0.7, channels: { height: false }, generator: { type: 'dirt', amount: 0.4 } },
      { name: 'Dust', material: 'dust', channels: { height: false }, generator: { type: 'facing', amount: 0.3 } },
    ],
  },
];

export interface SmartMaskPreset {
  id: string;
  name: string;
  preview: string;
  generator: Partial<GeneratorParams> & Pick<GeneratorParams, 'type'>;
}

export const SMART_MASKS: SmartMaskPreset[] = [
  { id: 'edge_wear', name: 'Edge Wear', preview: 'linear-gradient(135deg,#111 0 40%,#eee 48% 52%,#111 60%)', generator: { type: 'edge' } },
  {
    id: 'edge_chips',
    name: 'Edge Chips',
    preview: 'radial-gradient(circle at 70% 30%,#eee 0 12%,#111 14%), linear-gradient(#111,#111)',
    generator: { type: 'edge', amount: 0.3, contrast: 0.9, noiseAmount: 0.8, noiseScale: 18 },
  },
  { id: 'dirt', name: 'Dirt', preview: 'radial-gradient(circle,#111 0 45%,#ddd 75%)', generator: { type: 'dirt' } },
  { id: 'cavity', name: 'Cavity Grime', preview: 'radial-gradient(circle,#111 0 60%,#ddd 70%)', generator: { type: 'dirt', amount: 0.3, contrast: 0.8, noiseAmount: 0.2 } },
  { id: 'dust', name: 'Dust Top', preview: 'linear-gradient(#eee,#111)', generator: { type: 'facing' } },
  { id: 'grad_up', name: 'Gradient Bottom', preview: 'linear-gradient(#111,#eee)', generator: { type: 'gradient', axis: 1, invert: true } },
  { id: 'grad_down', name: 'Gradient Top', preview: 'linear-gradient(#eee,#111)', generator: { type: 'gradient', axis: 1 } },
  { id: 'clouds', name: 'Noise Clouds', preview: 'radial-gradient(circle at 30% 30%,#ddd,#333 50%,#999 80%)', generator: { type: 'noise', contrast: 0.3 } },
  {
    id: 'spots',
    name: 'Noise Spots',
    preview: 'radial-gradient(circle at 30% 40%,#eee 0 15%,#111 17%),radial-gradient(circle at 70% 60%,#eee 0 12%,#111 14%)',
    generator: { type: 'noise', amount: 0.3, contrast: 0.85, noiseScale: 9 },
  },
  { id: 'ao', name: 'Occlusion', preview: 'radial-gradient(circle,#222,#eee 70%)', generator: { type: 'ao', amount: 0.5, contrast: 0.2, noiseAmount: 0 } },
];
