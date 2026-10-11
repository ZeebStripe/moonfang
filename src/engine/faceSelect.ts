import * as THREE from 'three';
import { clearTarget, createRT, MeshPass, rawMaterial } from './gl';
import type { Topology } from './meshAnalysis';

/**
 * Face selection for polygon fill: which triangles are selected, how a click grows into a polygon / UV island /
 * mesh part, and GPU picking of the triangles under the cursor.
 */
export const FACE_MODES = [
  ['triangle', 'Triangle', 'Single triangles'],
  ['polygon', 'Polygon', 'Quads and other flat polygons (triangle pairs that share their longest edge)'],
  ['island', 'UV Island', 'Every triangle of the UV island (UV shell)'],
  ['element', 'Mesh Part', 'Every triangle connected to it in 3D'],
] as const;
export type FaceMode = (typeof FACE_MODES)[number][0];

/** Half-open triangle range [lo, hi): the active texture set. */
export type TriRange = readonly [number, number];

export class FaceSelection {
  /** 1 = selected, per triangle of the whole mesh */
  sel = new Uint8Array(0);
  mode: FaceMode = 'polygon';
  private uv: THREE.BufferAttribute | null = null;
  private topo: Topology | null = null;
  private partner: Int32Array | null = null;
  private island: Int32Array | null = null;
  private element: Int32Array | null = null;

  reset(topo: Topology, uv: THREE.BufferAttribute) {
    this.topo = topo;
    this.uv = uv;
    this.sel = new Uint8Array(Math.floor(topo.n / 3));
    this.partner = this.island = this.element = null;
  }

  count([lo, hi]: TriRange): number {
    let n = 0;
    for (let t = lo; t < hi; t++) n += this.sel[t];
    return n;
  }

  /** Selected triangles in the range. */
  list([lo, hi]: TriRange): number[] {
    const out: number[] = [];
    for (let t = lo; t < hi; t++) if (this.sel[t]) out.push(t);
    return out;
  }

  /** Grows picked triangles into whole polygons / islands / parts (within the range). */
  expand(tris: Iterable<number>, [lo, hi]: TriRange, mode = this.mode): number[] {
    const seeds = [...tris].filter((t) => t >= lo && t < hi);
    if (mode === 'triangle' || !seeds.length) return seeds;
    if (mode === 'polygon') {
      const p = (this.partner ??= polygonPartners(this.topo!));
      const out = new Set(seeds);
      for (const t of seeds) if (p[t] >= lo && p[t] < hi) out.add(p[t]);
      return [...out];
    }
    const comp = mode === 'island' ? (this.island ??= uvIslands(this.topo!, this.uv!)) : (this.element ??= meshParts(this.topo!));
    const roots = new Set(seeds.map((t) => comp[t]));
    const out: number[] = [];
    for (let t = lo; t < hi; t++) if (roots.has(comp[t])) out.push(t);
    return out;
  }

  apply(tris: Iterable<number>, op: 'add' | 'remove') {
    const v = op === 'add' ? 1 : 0;
    for (const t of tris) this.sel[t] = v;
  }

  setAll([lo, hi]: TriRange, v: 0 | 1) {
    this.sel.fill(v, lo, hi);
  }

  invert([lo, hi]: TriRange) {
    for (let t = lo; t < hi; t++) this.sel[t] ^= 1;
  }
}

/** Copies the given triangles of a non-indexed geometry (the listed attributes only). */
export function subsetGeometry(g: THREE.BufferGeometry, tris: ArrayLike<number>, attrs: string[] = ['position', 'normal', 'uv']): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const key of attrs) {
    const a = g.attributes[key] as THREE.BufferAttribute;
    const s = a.itemSize;
    const src = a.array as Float32Array;
    const f = new Float32Array(tris.length * 3 * s);
    for (let i = 0; i < tris.length; i++) f.set(src.subarray(tris[i] * 3 * s, (tris[i] + 1) * 3 * s), i * 3 * s);
    out.setAttribute(key, new THREE.BufferAttribute(f, s));
  }
  return out;
}

class UnionFind {
  p: Int32Array;
  constructor(n: number) {
    this.p = new Int32Array(n);
    for (let i = 0; i < n; i++) this.p[i] = i;
  }
  find(x: number): number {
    const p = this.p;
    while (p[x] !== x) x = p[x] = p[p[x]];
    return x;
  }
  union(a: number, b: number) {
    a = this.find(a);
    b = this.find(b);
    if (a !== b) this.p[Math.max(a, b)] = Math.min(a, b);
  }
  roots(): Int32Array {
    const out = new Int32Array(this.p.length);
    for (let i = 0; i < out.length; i++) out[i] = this.find(i);
    return out;
  }
}

/**
 * The other half of each triangulated quad (or -1): the neighbour across this triangle's longest edge, when that
 * edge is the neighbour's longest too and both are (nearly) coplanar. Matches how quads and n-gons are split.
 */
function polygonPartners(topo: Topology): Int32Array {
  const { weld, wp, fn, W } = topo;
  const T = Math.floor(topo.n / 3);
  const partner = new Int32Array(T).fill(-1);
  const first = new Map<number, number>();
  const d2 = (a: number, b: number) => (wp[a * 3] - wp[b * 3]) ** 2 + (wp[a * 3 + 1] - wp[b * 3 + 1]) ** 2 + (wp[a * 3 + 2] - wp[b * 3 + 2]) ** 2;
  for (let t = 0; t < T; t++) {
    let best = -1;
    let key = -1;
    for (let e = 0; e < 3; e++) {
      const a = weld[t * 3 + e];
      const b = weld[t * 3 + ((e + 1) % 3)];
      const l = d2(a, b);
      if (l > best) {
        best = l;
        key = Math.min(a, b) * W + Math.max(a, b);
      }
    }
    const o = first.get(key);
    if (o === undefined) first.set(key, t);
    else if (partner[o] < 0 && fn[o * 3] * fn[t * 3] + fn[o * 3 + 1] * fn[t * 3 + 1] + fn[o * 3 + 2] * fn[t * 3 + 2] > 0.995) {
      partner[o] = t;
      partner[t] = o;
    }
  }
  return partner;
}

/** UV island id per triangle: triangles sharing an edge in both 3D and UV space. */
function uvIslands(topo: Topology, uv: THREE.BufferAttribute): Int32Array {
  const { weld } = topo;
  const T = Math.floor(topo.n / 3);
  const ids = new Map<string, number>();
  const vid = new Int32Array(T * 3);
  const q = 1e5;
  for (let i = 0; i < T * 3; i++) {
    const k = `${weld[i]}|${Math.round(uv.getX(i) * q)}|${Math.round(uv.getY(i) * q)}`;
    let id = ids.get(k);
    if (id === undefined) ids.set(k, (id = ids.size));
    vid[i] = id;
  }
  const V = ids.size;
  const uf = new UnionFind(T);
  const edges = new Map<number, number>();
  for (let t = 0; t < T; t++) {
    for (let e = 0; e < 3; e++) {
      const a = vid[t * 3 + e];
      const b = vid[t * 3 + ((e + 1) % 3)];
      const key = Math.min(a, b) * V + Math.max(a, b);
      const o = edges.get(key);
      if (o === undefined) edges.set(key, t);
      else uf.union(o, t);
    }
  }
  return uf.roots();
}

/** Connected-part id per triangle (triangles sharing a welded vertex). */
function meshParts(topo: Topology): Int32Array {
  const { W, vfStart, vfList } = topo;
  const uf = new UnionFind(Math.floor(topo.n / 3));
  for (let v = 0; v < W; v++) for (let i = vfStart[v] + 1; i < vfStart[v + 1]; i++) uf.union(vfList[vfStart[v]], vfList[i]);
  return uf.roots();
}

const ID_FRAG = /* glsl */ `
flat in int vTri;
uniform int uLo;
uniform int uHi;
layout(location = 0) out vec4 o0;
void main() {
  // Other texture sets still hide what is behind them, but cannot be picked (0 = nothing).
  if (vTri < uLo || vTri >= uHi) { o0 = vec4(0.0); return; }
  uint id = uint(vTri + 1);
  o0 = vec4(float(id & 255u), float((id >> 8u) & 255u), float((id >> 16u) & 255u), float(id >> 24u)) / 255.0;
}`;

const ID_VERT = /* glsl */ `
in vec3 position;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
flat out int vTri;
void main() {
  vTri = gl_VertexID / 3; // non-indexed geometry drawn from vertex 0
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/**
 * Triangle ids of the visible surface, rendered once per view and read back to the CPU, so hovering and box
 * selection are lookups. Re-rendered when the camera, canvas size, geometry or range changes.
 */
export class FacePicker {
  private rt: THREE.WebGLRenderTarget | null = null;
  private bytes = new Uint8Array(0);
  private ids = new Uint32Array(0);
  private key = '';
  private pass: MeshPass | null = null;
  private mat = (() => {
    const m = rawMaterial(ID_FRAG, { uLo: { value: 0 }, uHi: { value: 0 } }, { vertex: ID_VERT });
    m.depthTest = true;
    m.depthWrite = true;
    return m;
  })();
  width = 0;
  height = 0;

  constructor(private renderer: THREE.WebGLRenderer) {}

  /** Makes sure the id buffer matches this view. */
  update(geometry: THREE.BufferGeometry, camera: THREE.Camera, [lo, hi]: TriRange) {
    const r = this.renderer;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    camera.updateMatrixWorld();
    const key = [geometry.uuid, lo, hi, size.x, size.y, ...camera.matrixWorld.elements, ...camera.projectionMatrix.elements].join(',');
    if (key === this.key) return;
    this.key = key;
    if (!this.rt || this.rt.width !== size.x || this.rt.height !== size.y) {
      this.rt?.dispose();
      this.rt = createRT(size.x, size.y, { depth: true });
      this.bytes = new Uint8Array(size.x * size.y * 4);
      this.ids = new Uint32Array(this.bytes.buffer);
    }
    this.width = size.x;
    this.height = size.y;
    if (this.pass?.mesh.geometry !== geometry) this.pass = new MeshPass(geometry);
    this.mat.uniforms.uLo.value = lo;
    this.mat.uniforms.uHi.value = hi;
    clearTarget(r, this.rt, 0, 0, 0, 0);
    this.pass.render(r, this.mat, this.rt, camera);
    r.readRenderTargetPixels(this.rt, 0, 0, size.x, size.y, this.bytes);
    r.setRenderTarget(null);
  }

  invalidate() {
    this.key = '';
  }

  /** Triangle at a drawing-buffer pixel (origin bottom-left), or -1. */
  at(x: number, y: number): number {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return -1;
    return this.ids[y * this.width + x] - 1;
  }

  /** Triangles visible inside a drawing-buffer rectangle. */
  inRect(x0: number, y0: number, x1: number, y1: number): Set<number> {
    const out = new Set<number>();
    const xa = Math.max(0, Math.floor(Math.min(x0, x1)));
    const xb = Math.min(this.width - 1, Math.ceil(Math.max(x0, x1)));
    const ya = Math.max(0, Math.floor(Math.min(y0, y1)));
    const yb = Math.min(this.height - 1, Math.ceil(Math.max(y0, y1)));
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const id = this.ids[y * this.width + x];
        if (id) out.add(id - 1);
      }
    }
    return out;
  }

  dispose() {
    this.rt?.dispose();
    this.rt = null;
    this.key = '';
  }
}
