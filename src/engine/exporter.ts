import * as THREE from 'three';
import { zipSync, zlibSync } from 'fflate';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { createRT, FullscreenPass, GLSL_NOISE, rawMaterial } from './gl';
import type { PaintMesh } from './meshLoader';

/** Channel sources an export map can pull from. */
const SRC = { baseR: 0, baseG: 1, baseB: 2, ao: 3, rough: 4, metal: 5, height: 6, nX: 7, nY: 8, nZ: 9, one: 10, zero: 11, smooth: 12 } as const;
type Src = keyof typeof SRC;

interface ExportMap {
  suffix: string;
  channels: Src[]; // 1 = grey, 3 = RGB, 4 = RGBA
}

export interface ExportPreset {
  id: string;
  name: string;
  normal: 'opengl' | 'directx';
  maps: ExportMap[];
}

const BASE: ExportMap = { suffix: 'BaseColor', channels: ['baseR', 'baseG', 'baseB'] };
const NORMAL: ExportMap = { suffix: 'Normal', channels: ['nX', 'nY', 'nZ'] };

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
    ],
  },
  {
    id: 'gltf',
    name: 'glTF / Godot / three.js (ORM)',
    normal: 'opengl',
    maps: [BASE, { suffix: 'ORM', channels: ['ao', 'rough', 'metal'] }, NORMAL],
  },
  {
    id: 'unreal',
    name: 'Unreal Engine (ORM, DirectX normal)',
    normal: 'directx',
    maps: [BASE, { suffix: 'OcclusionRoughnessMetallic', channels: ['ao', 'rough', 'metal'] }, NORMAL],
  },
  {
    id: 'unity_urp',
    name: 'Unity URP (Metallic + Smoothness)',
    normal: 'opengl',
    maps: [
      { suffix: 'BaseMap', channels: ['baseR', 'baseG', 'baseB'] },
      { suffix: 'MetallicSmoothness', channels: ['metal', 'metal', 'metal', 'smooth'] },
      NORMAL,
      { suffix: 'Occlusion', channels: ['ao'] },
    ],
  },
  {
    id: 'unity_hdrp',
    name: 'Unity HDRP (Mask Map)',
    normal: 'opengl',
    maps: [
      { suffix: 'BaseMap', channels: ['baseR', 'baseG', 'baseB'] },
      { suffix: 'MaskMap', channels: ['metal', 'ao', 'zero', 'smooth'] },
      NORMAL,
    ],
  },
];

const EXPORT_FRAG = /* glsl */ `
in vec2 vUv;
layout(location = 0) out vec4 o0;
uniform sampler2D uBase;
uniform sampler2D uOrm;
uniform sampler2D uNormal;
uniform ivec4 uSrc;
uniform int uFlipGreen;
${GLSL_NOISE}
float pick(int s, vec3 base, vec4 orm, vec3 n) {
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
  vec3 base = linearToSrgb(texture(uBase, vUv).rgb);
  vec4 orm = texture(uOrm, vUv);
  vec3 n = texture(uNormal, vUv).rgb;
  o0 = vec4(pick(uSrc.x, base, orm, n), pick(uSrc.y, base, orm, n), pick(uSrc.z, base, orm, n), pick(uSrc.w, base, orm, n));
}
`;

export interface ExportOptions {
  preset: ExportPreset;
  normal: 'opengl' | 'directx';
  baseName: string;
}

export class Exporter {
  private mat = rawMaterial(EXPORT_FRAG, {
    uBase: { value: null },
    uOrm: { value: null },
    uNormal: { value: null },
    uSrc: { value: new THREE.Vector4() },
    uFlipGreen: { value: 0 },
  });

  constructor(
    private renderer: THREE.WebGLRenderer,
    private fs: FullscreenPass,
  ) {}

  /**
   * Renders one export map to RGBA8 and returns rows in GL order (row 0 = v 0).
   * `flipGreen` inverts the normal Y channel.
   */
  private renderMap(final: THREE.WebGLRenderTarget, map: ExportMap, flipGreen: boolean): Uint8Array {
    const size = final.width;
    const rt = createRT(size, size);
    const u = this.mat.uniforms;
    u.uBase.value = final.textures[0];
    u.uOrm.value = final.textures[1];
    u.uNormal.value = final.textures[2];
    const ch = map.channels;
    const s = (i: number) => SRC[ch[Math.min(i, ch.length - 1)]];
    u.uSrc.value.set(s(0), s(1), s(2), ch.length === 4 ? SRC[ch[3]] : SRC.one);
    u.uFlipGreen.value = flipGreen ? 1 : 0;
    this.fs.render(this.renderer, this.mat, rt);
    const buf = new Uint8Array(size * size * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf);
    this.renderer.setRenderTarget(null);
    rt.dispose();
    return buf;
  }

  /** Returns a zip containing one PNG per map of the preset. */
  exportTextures(final: THREE.WebGLRenderTarget, mesh: PaintMesh, o: ExportOptions): Uint8Array {
    const size = final.width;
    // glTF UVs have v=0 at the image top; everything else uses the OpenGL convention (v=0 at the bottom).
    const gltfUVs = isGltfSource(mesh);
    const files: Record<string, Uint8Array> = {};
    for (const map of o.preset.maps) {
      const isNormal = map.channels.includes('nY');
      // Our normals have +G along +v. Bring them into image-space OpenGL convention first, then optionally to DirectX.
      let flip = gltfUVs;
      if (isNormal && o.normal === 'directx') flip = !flip;
      const rgba = this.renderMap(final, map, isNormal && flip);
      const png = encodePNG(rgba, size, size, map.channels.length, !gltfUVs);
      files[`${o.baseName}_${map.suffix}.png`] = png;
    }
    return zipSync(files, { level: 0 });
  }

  /** Exports the mesh in its original placement with the painted material as a binary glTF. */
  async exportGLB(final: THREE.WebGLRenderTarget, mesh: PaintMesh): Promise<ArrayBuffer> {
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
    const material = new THREE.MeshStandardMaterial({
      map: tex(BASE, true),
      roughnessMap: orm,
      metalnessMap: orm,
      aoMap: orm,
      // Our normals follow three.js' derivative-tangent convention (+G along +v); with normalScale (1, 1)
      // GLTFExporter converts them to glTF's OpenGL convention itself.
      normalMap: tex(NORMAL, false),
      roughness: 1,
      metalness: 1,
    });
    material.name = `${mesh.name}_material`;
    const geometry = mesh.geometry.clone();
    geometry.deleteAttribute('curv');
    geometry.scale(1 / mesh.scale, 1 / mesh.scale, 1 / mesh.scale);
    geometry.translate(mesh.center.x, mesh.center.y, mesh.center.z);
    const out = new THREE.Mesh(geometry, material);
    out.name = mesh.name;
    const result = await new GLTFExporter().parseAsync(out, { binary: true });
    geometry.dispose();
    return result as ArrayBuffer;
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
  const idat = zlibSync(raw, { level: 6 });
  const colorType = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  const chunks: [string, Uint8Array][] = [
    ['IHDR', new Uint8Array([w >>> 24, (w >>> 16) & 255, (w >>> 8) & 255, w & 255, h >>> 24, (h >>> 16) & 255, (h >>> 8) & 255, h & 255, 8, colorType, 0, 0, 0])],
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
