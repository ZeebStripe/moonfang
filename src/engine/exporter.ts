import * as THREE from 'three';
import { zipSync, zlibSync } from 'fflate';
import { createRT, FullscreenPass, GLSL_NOISE, rawMaterial } from './gl';
import type { PaintMesh } from './meshLoader';

/** Channel sources an export map can pull from. */
const SRC = { baseR: 0, baseG: 1, baseB: 2, ao: 3, rough: 4, metal: 5, height: 6, nX: 7, nY: 8, nZ: 9, one: 10, zero: 11, smooth: 12, opacity: 13, emR: 14, emG: 15, emB: 16 } as const;
type Src = keyof typeof SRC;

interface ExportMap {
  suffix: string;
  channels: Src[]; // 1 = grey, 3 = RGB, 4 = RGBA
  /** 'alpha': the 4th channel is dropped when it is fully opaque; 'map': the map is skipped when it is all black */
  optional?: 'alpha' | 'map';
}

export interface ExportPreset {
  id: string;
  name: string;
  normal: 'opengl' | 'directx';
  maps: ExportMap[];
}

const BASE: ExportMap = { suffix: 'BaseColor', channels: ['baseR', 'baseG', 'baseB', 'opacity'], optional: 'alpha' };
const NORMAL: ExportMap = { suffix: 'Normal', channels: ['nX', 'nY', 'nZ'] };
const EMISSIVE: ExportMap = { suffix: 'Emissive', channels: ['emR', 'emG', 'emB'], optional: 'map' };

export const EXPORT_PRESETS: ExportPreset[] = [
  {
    id: 'separate',
    name: 'PBR Metal/Rough (separate maps)',
    normal: 'opengl',
    maps: [
      BASE,
      { suffix: 'Roughness', channels: ['rough'] },
      { suffix: 'Metallic', channels: ['metal'] },
      NORMAL,
      { suffix: 'Height', channels: ['height'] },
      { suffix: 'AO', channels: ['ao'] },
      EMISSIVE,
    ],
  },
  {
    id: 'gltf',
    name: 'glTF / Godot / three.js (ORM)',
    normal: 'opengl',
    maps: [BASE, { suffix: 'ORM', channels: ['ao', 'rough', 'metal'] }, NORMAL, EMISSIVE],
  },
  {
    id: 'unreal',
    name: 'Unreal Engine (ORM, DirectX normal)',
    normal: 'directx',
    maps: [BASE, { suffix: 'OcclusionRoughnessMetallic', channels: ['ao', 'rough', 'metal'] }, NORMAL, EMISSIVE],
  },
  {
    id: 'unity_urp',
    name: 'Unity URP (Metallic + Smoothness)',
    normal: 'opengl',
    maps: [
      { suffix: 'BaseMap', channels: ['baseR', 'baseG', 'baseB', 'opacity'], optional: 'alpha' },
      { suffix: 'MetallicSmoothness', channels: ['metal', 'metal', 'metal', 'smooth'] },
      NORMAL,
      { suffix: 'Occlusion', channels: ['ao'] },
      EMISSIVE,
    ],
  },
  {
    id: 'unity_hdrp',
    name: 'Unity HDRP (Mask Map)',
    normal: 'opengl',
    maps: [
      { suffix: 'BaseMap', channels: ['baseR', 'baseG', 'baseB', 'opacity'], optional: 'alpha' },
      { suffix: 'MaskMap', channels: ['metal', 'ao', 'zero', 'smooth'] },
      NORMAL,
      EMISSIVE,
    ],
  },
];

const EXPORT_FRAG = /* glsl */ `
in vec2 vUv;
layout(location = 0) out vec4 o0;
uniform sampler2D uBase;
uniform sampler2D uOrm;
uniform sampler2D uNormal;
uniform sampler2D uEmissive;
uniform ivec4 uSrc;
uniform int uFlipGreen;
uniform int uLinear;   // 1: keep color maps linear (EXR convention)
${GLSL_NOISE}
vec3 em;
float alpha;
float pick(int s, vec3 base, vec4 orm, vec3 n) {
  if (s == 13) return alpha;
  if (s == 14) return em.r;
  if (s == 15) return em.g;
  if (s == 16) return em.b;
  if (s == 0) return base.r;
  if (s == 1) return base.g;
  if (s == 2) return base.b;
  if (s == 3) return orm.r;
  if (s == 4) return orm.g;
  if (s == 5) return orm.b;
  if (s == 6) return orm.a;
  if (s == 7) return n.x;
  if (s == 8) return uFlipGreen == 1 ? 1.0 - n.y : n.y;
  if (s == 9) return n.z;
  if (s == 10) return 1.0;
  if (s == 11) return 0.0;
  return 1.0 - orm.g;
}
void main() {
  vec4 b4 = texture(uBase, vUv);
  vec3 base = uLinear == 1 ? b4.rgb : linearToSrgb(b4.rgb);
  alpha = b4.a;
  vec3 e = texture(uEmissive, vUv).rgb;
  em = uLinear == 1 ? e : linearToSrgb(e);
  vec4 orm = texture(uOrm, vUv);
  vec3 n = texture(uNormal, vUv).rgb;
  o0 = vec4(pick(uSrc.x, base, orm, n), pick(uSrc.y, base, orm, n), pick(uSrc.z, base, orm, n), pick(uSrc.w, base, orm, n));
}
`;

export interface ExportSet {
  name: string;
  final: THREE.WebGLRenderTarget;
}

const fileSafe = (s: string) => s.replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '') || 'set';

/** File-name prefix per texture set; set names that sanitise to the same string get _2, _3 … so no files overwrite. */
export function exportPrefixes(baseName: string, setNames: string[]): string[] {
  if (setNames.length === 1) return [baseName];
  const used = new Set<string>();
  return setNames.map((n) => {
    const stem = `${baseName}_${fileSafe(n)}`;
    let p = stem;
    for (let i = 2; used.has(p.toLowerCase()); i++) p = `${stem}_${i}`;
    used.add(p.toLowerCase());
    return p;
  });
}

export type ExportFormat = 'png8' | 'png16' | 'exr';
export const EXPORT_FORMATS: [ExportFormat, string][] = [
  ['png8', 'PNG 8-bit'],
  ['png16', 'PNG 16-bit'],
  ['exr', 'OpenEXR (half float, linear color)'],
];

export interface ExportOptions {
  preset: ExportPreset;
  normal: 'opengl' | 'directx';
  baseName: string;
  /** default 'png8' */
  format?: ExportFormat;
}

export class Exporter {
  private mat = rawMaterial(EXPORT_FRAG, {
    uBase: { value: null },
    uOrm: { value: null },
    uNormal: { value: null },
    uEmissive: { value: null },
    uSrc: { value: new THREE.Vector4() },
    uFlipGreen: { value: 0 },
    uLinear: { value: 0 },
  });

  constructor(
    private renderer: THREE.WebGLRenderer,
    private fs: FullscreenPass,
  ) {}

  /**
   * Renders one export map to RGBA8 and returns rows in GL order (row 0 = v 0).
   * `flipGreen` inverts the normal Y channel.
   */
  private renderMap(final: THREE.WebGLRenderTarget, map: ExportMap, flipGreen: boolean): Uint8Array;
  private renderMap(final: THREE.WebGLRenderTarget, map: ExportMap, flipGreen: boolean, float: true, linear: boolean): Float32Array;
  private renderMap(final: THREE.WebGLRenderTarget, map: ExportMap, flipGreen: boolean, float = false, linear = false): Uint8Array | Float32Array {
    const size = final.width;
    const rt = createRT(size, size, float ? { type: THREE.FloatType } : {});
    const u = this.mat.uniforms;
    u.uBase.value = final.textures[0];
    u.uOrm.value = final.textures[1];
    u.uNormal.value = final.textures[2];
    u.uEmissive.value = final.textures[3];
    const ch = map.channels;
    const s = (i: number) => SRC[ch[Math.min(i, ch.length - 1)]];
    u.uSrc.value.set(s(0), s(1), s(2), ch.length === 4 ? SRC[ch[3]] : SRC.one);
    u.uFlipGreen.value = flipGreen ? 1 : 0;
    u.uLinear.value = linear ? 1 : 0;
    this.fs.render(this.renderer, this.mat, rt);
    const buf = float ? new Float32Array(size * size * 4) : new Uint8Array(size * size * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf);
    this.renderer.setRenderTarget(null);
    rt.dispose();
    return buf;
  }

  /** One zip with one image per map of the preset and texture set; with several sets the set name goes into each file name. */
  async exportTextures(sets: ExportSet[], mesh: PaintMesh, o: ExportOptions): Promise<Uint8Array> {
    const files: Record<string, Uint8Array> = {};
    const prefixes = exportPrefixes(o.baseName, sets.map((s) => s.name));
    for (const [i, set] of sets.entries()) Object.assign(files, await this.exportSet(set.final, mesh, o, prefixes[i]));
    return zipSync(files, { level: 0 });
  }

  private async exportSet(final: THREE.WebGLRenderTarget, mesh: PaintMesh, o: ExportOptions, prefix: string): Promise<Record<string, Uint8Array>> {
    const format = o.format ?? 'png8';
    const size = final.width;
    // glTF UVs have v=0 at the image top; everything else uses the OpenGL convention (v=0 at the bottom).
    const gltfUVs = isGltfSource(mesh);
    const files: Record<string, Uint8Array> = {};
    for (const map of o.preset.maps) {
      const isNormal = map.channels.includes('nY');
      // Our normals have +G along +v. Bring them into image-space OpenGL convention first, then optionally to DirectX.
      let flip = gltfUVs;
      if (isNormal && o.normal === 'directx') flip = !flip;
      const name = `${prefix}_${map.suffix}`;
      if (format === 'png8') {
        const rgba = this.renderMap(final, map, isNormal && flip);
        if (map.optional === 'map' && !anyNonZero(rgba)) continue;
        const channels = map.optional === 'alpha' && !anyTransparent(rgba) ? 3 : map.channels.length;
        files[`${name}.png`] = encodePNG(rgba, size, size, channels, !gltfUVs);
        continue;
      }
      const data = this.renderMap(final, map, isNormal && flip, true, format === 'exr');
      if (map.optional === 'map' && !anyNonZero(data, 0.5 / 255)) continue;
      if (format === 'png16') {
        const channels = map.optional === 'alpha' && !anyTransparent(data, 1 - 0.5 / 65535) ? 3 : map.channels.length;
        files[`${name}.png`] = encodePNG16(data, size, size, channels, !gltfUVs);
      } else {
        // EXRExporter writes GL row 0 last (standard image orientation); glTF UVs need row 0 first.
        if (gltfUVs) flipRowsInPlace(data, size, size);
        const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
        const { EXRExporter, ZIP_COMPRESSION } = await import('three/examples/jsm/exporters/EXRExporter.js');
        files[`${name}.exr`] = await new EXRExporter().parse(tex, { type: THREE.HalfFloatType, compression: ZIP_COMPRESSION });
      }
    }
    return files;
  }

  /** Exports the mesh in its original placement as a binary glTF, one material per texture set (geometry groups map to glTF primitives). */
  async exportGLB(sets: ExportSet[], mesh: PaintMesh): Promise<ArrayBuffer> {
    const materials = sets.map((s) => this.glbMaterial(s.final, `${mesh.name}_${s.name}`));
    const geometry = mesh.geometry.clone();
    geometry.deleteAttribute('curv');
    geometry.scale(1 / mesh.scale, 1 / mesh.scale, 1 / mesh.scale);
    geometry.translate(mesh.center.x, mesh.center.y, mesh.center.z);
    const out = new THREE.Mesh(geometry, materials);
    out.name = mesh.name;
    const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
    const result = await new GLTFExporter().parseAsync(out, { binary: true });
    geometry.dispose();
    return result as ArrayBuffer;
  }

  private glbMaterial(final: THREE.WebGLRenderTarget, name: string): THREE.MeshStandardMaterial {
    const size = final.width;
    // GLTFExporter re-encodes textures through a 2D canvas, so hand it canvases. GL row 0 (v = 0) goes to the
    // canvas top, matching glTF's top-left UV origin for the raw UVs we export.
    const tex = (map: ExportMap, srgb: boolean) => {
      const data = this.renderMap(final, map, false);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data.buffer as ArrayBuffer), size, size), 0, 0);
      const t = new THREE.CanvasTexture(canvas);
      t.flipY = false;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      return t;
    };
    const orm = tex({ suffix: 'orm', channels: ['ao', 'rough', 'metal'] }, false);
    const base = tex(BASE, true);
    const emissive = tex(EMISSIVE, true);
    const baseData = (base.image as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, size, size).data;
    const emData = (emissive.image as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, size, size).data;
    const material = new THREE.MeshStandardMaterial({
      map: base,
      // glTF alphaMode BLEND only when the opacity channel is actually used
      transparent: anyTransparent(baseData),
      emissiveMap: anyNonZero(emData) ? emissive : null,
      emissive: anyNonZero(emData) ? 0xffffff : 0x000000,
      roughnessMap: orm,
      metalnessMap: orm,
      aoMap: orm,
      // Our normals follow three.js' derivative-tangent convention (+G along +v); with normalScale (1, 1)
      // GLTFExporter converts them to glTF's OpenGL convention itself.
      normalMap: tex(NORMAL, false),
      roughness: 1,
      metalness: 1,
    });
    material.name = name;
    return material;
  }
}

/** Any RGB above `eps` in an RGBA buffer (8-bit or float). */
function anyNonZero(rgba: ArrayLike<number>, eps = 0) {
  for (let i = 0; i < rgba.length; i += 4) if (rgba[i] > eps || rgba[i + 1] > eps || rgba[i + 2] > eps) return true;
  return false;
}

/** Any alpha below `opaque` in an RGBA buffer (8-bit: 255, float: ~1). */
function anyTransparent(rgba: ArrayLike<number>, opaque = 255) {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < opaque) return true;
  return false;
}

function flipRowsInPlace(data: Float32Array, w: number, h: number) {
  const row = w * 4;
  const tmp = new Float32Array(row);
  for (let y = 0; y < h >> 1; y++) {
    const a = y * row;
    const b = (h - 1 - y) * row;
    tmp.set(data.subarray(a, a + row));
    data.copyWithin(a, b, b + row);
    data.set(tmp, b);
  }
}

export function isGltfSource(mesh: PaintMesh) {
  return mesh.source.kind === 'file' && /\.(glb|gltf)$/i.test(mesh.source.name);
}

// ---------------------------------------------------------------------------------------------
// Minimal PNG encoder (8-bit grey / RGB / RGBA). Canvas encoding premultiplies alpha, which would
// destroy data stored in the alpha channel (e.g. smoothness), so we write the file ourselves.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array, start: number, end: number) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param rgba     tightly packed RGBA8 pixels, GL row order (row 0 = bottom)
 * @param channels 1, 3 or 4
 * @param flipRows true to write the last GL row first (standard image orientation)
 */
export function encodePNG(rgba: Uint8Array, w: number, h: number, channels: number, flipRows: boolean): Uint8Array {
  const stride = w * channels;
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const srcRow = flipRows ? h - 1 - y : y;
    const o = y * (stride + 1);
    raw[o] = 1; // Sub filter
    let prev0 = 0,
      prev1 = 0,
      prev2 = 0,
      prev3 = 0;
    for (let x = 0; x < w; x++) {
      const s = (srcRow * w + x) * 4;
      const d = o + 1 + x * channels;
      if (channels === 1) {
        const v = rgba[s];
        raw[d] = (v - prev0) & 0xff;
        prev0 = v;
      } else {
        const r = rgba[s],
          g = rgba[s + 1],
          b = rgba[s + 2];
        raw[d] = (r - prev0) & 0xff;
        raw[d + 1] = (g - prev1) & 0xff;
        raw[d + 2] = (b - prev2) & 0xff;
        prev0 = r;
        prev1 = g;
        prev2 = b;
        if (channels === 4) {
          const a = rgba[s + 3];
          raw[d + 3] = (a - prev3) & 0xff;
          prev3 = a;
        }
      }
    }
  }
  return pngFile(w, h, 8, channels === 1 ? 0 : channels === 3 ? 2 : 6, zlibSync(raw, { level: 6 }));
}

/**
 * 16-bit PNG (grey / RGB / RGBA) from float RGBA pixels in 0..1, GL row order.
 * @param flipRows true to write the last GL row first (standard image orientation)
 */
export function encodePNG16(rgba: Float32Array, w: number, h: number, channels: number, flipRows: boolean): Uint8Array {
  const bpp = channels * 2;
  const stride = w * bpp;
  const raw = new Uint8Array((stride + 1) * h);
  const row = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const srcRow = flipRows ? h - 1 - y : y;
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < channels; c++) {
        const v = Math.round(Math.min(1, Math.max(0, rgba[(srcRow * w + x) * 4 + c])) * 65535);
        row[x * bpp + c * 2] = v >>> 8; // big-endian samples
        row[x * bpp + c * 2 + 1] = v & 255;
      }
    }
    const o = y * (stride + 1);
    raw[o] = 1; // Sub filter
    for (let i = 0; i < stride; i++) raw[o + 1 + i] = (row[i] - (i >= bpp ? row[i - bpp] : 0)) & 0xff;
  }
  return pngFile(w, h, 16, channels === 1 ? 0 : channels === 3 ? 2 : 6, zlibSync(raw, { level: 6 }));
}

function pngFile(w: number, h: number, depth: number, colorType: number, idat: Uint8Array): Uint8Array {
  const chunks: [string, Uint8Array][] = [
    ['IHDR', new Uint8Array([w >>> 24, (w >>> 16) & 255, (w >>> 8) & 255, w & 255, h >>> 24, (h >>> 16) & 255, (h >>> 8) & 255, h & 255, depth, colorType, 0, 0, 0])],
    ['IDAT', idat],
    ['IEND', new Uint8Array(0)],
  ];
  let total = 8;
  for (const [, d] of chunks) total += 12 + d.length;
  const out = new Uint8Array(total);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let p = 8;
  const dv = new DataView(out.buffer);
  for (const [type, d] of chunks) {
    dv.setUint32(p, d.length);
    for (let i = 0; i < 4; i++) out[p + 4 + i] = type.charCodeAt(i);
    out.set(d, p + 8);
    dv.setUint32(p + 8 + d.length, crc32(out, p + 4, p + 8 + d.length));
    p += 12 + d.length;
  }
  return out;
}

export function downloadBlob(data: BlobPart, filename: string, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
