import * as THREE from 'three';
import { MeshBVH, MeshBVHUniformStruct } from 'three-mesh-bvh';

/**
 * Welded topology of a non-indexed triangle mesh: shared positions, face normals and vertex → face adjacency.
 * Curvature and sharp-edge extraction both work on it.
 */
export interface Topology {
  /** non-indexed vertex count */
  n: number;
  /** non-indexed vertex → welded vertex */
  weld: Int32Array;
  /** welded vertex count and positions */
  W: number;
  wp: Float32Array;
  /** unit face normal and doubled area per triangle */
  fn: Float32Array;
  fa: Float32Array;
  /** welded vertex → incident faces (CSR) */
  vfStart: Int32Array;
  vfList: Int32Array;
  /** the mesh's shading normal per non-indexed vertex (null without a normal attribute) */
  sn: Float32Array | null;
}

/** Whether the shading normals of faces f and g agree at welded vertex v (smooth shading there). */
function smoothAt(topo: Topology, f: number, g: number, v: number): boolean {
  const { sn, weld } = topo;
  if (!sn) return false;
  let a = -1,
    b = -1;
  for (let k = 0; k < 3; k++) {
    if (weld[f * 3 + k] === v) a = f * 3 + k;
    if (weld[g * 3 + k] === v) b = g * 3 + k;
  }
  if (a < 0 || b < 0) return false;
  return sn[a * 3] * sn[b * 3] + sn[a * 3 + 1] * sn[b * 3 + 1] + sn[a * 3 + 2] * sn[b * 3 + 2] > 0.9995;
}

/** Above this share of interior edges sharper than the angle yet shaded smooth, the mesh's shading decides. */
const COARSE_SMOOTH_SHARE = 0.05;
const shadingCache = new WeakMap<Topology, { angle: number; follows: boolean }>();

/**
 * Whether sharp edges should follow the mesh's shading instead of the angle alone. A coarse organic mesh (a game
 * character) is shaded smooth across many edges sharper than any useful angle: as hard edges they would cover it in
 * spikes, so there only edges with split normals are hard and the rest goes to the (graded) vertex curvature. A
 * hard-surface mesh has few such edges (a smooth-shaded rim or base); it keeps the angle rule and its crisp edges.
 */
export function followsShading(topo: Topology, sharpAngle: number): boolean {
  const hit = shadingCache.get(topo);
  if (hit?.angle === sharpAngle) return hit.follows;
  let follows = false;
  if (topo.sn) {
    const { weld, fn, vfStart, vfList } = topo;
    const cosT = Math.cos(THREE.MathUtils.degToRad(sharpAngle));
    let edges = 0,
      smooth = 0;
    for (let t = 0; t < topo.n / 3; t++) {
      for (let k = 0; k < 3; k++) {
        const a = weld[t * 3 + k],
          b = weld[t * 3 + ((k + 1) % 3)];
        // The face across edge a–b; each interior edge is counted once, from its lower-numbered face.
        let f = -1;
        for (let j = vfStart[a]; j < vfStart[a + 1] && f < 0; j++) {
          const g = vfList[j];
          if (g > t && (weld[g * 3] === b || weld[g * 3 + 1] === b || weld[g * 3 + 2] === b)) f = g;
        }
        if (f < 0) continue;
        edges++;
        const dot = fn[t * 3] * fn[f * 3] + fn[t * 3 + 1] * fn[f * 3 + 1] + fn[t * 3 + 2] * fn[f * 3 + 2];
        if (dot < cosT && smoothAt(topo, t, f, a) && smoothAt(topo, t, f, b)) smooth++;
      }
    }
    follows = smooth > COARSE_SMOOTH_SHARE * edges;
  }
  shadingCache.set(topo, { angle: sharpAngle, follows });
  return follows;
}

export function buildTopology(g: THREE.BufferGeometry): Topology {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const n = pos.count;
  const T = Math.floor(n / 3);
  const weld = new Int32Array(n);
  const map = new Map<string, number>();
  const wpList: number[] = [];
  const q = 1e5;
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i),
      y = pos.getY(i),
      z = pos.getZ(i);
    const key = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = wpList.length / 3;
      map.set(key, id);
      wpList.push(x, y, z);
    }
    weld[i] = id;
  }
  const W = wpList.length / 3;
  const wp = new Float32Array(wpList);
  const fn = new Float32Array(T * 3);
  const fa = new Float32Array(T);
  for (let t = 0; t < T; t++) {
    const a = weld[t * 3] * 3,
      b = weld[t * 3 + 1] * 3,
      c = weld[t * 3 + 2] * 3;
    const e1x = wp[b] - wp[a],
      e1y = wp[b + 1] - wp[a + 1],
      e1z = wp[b + 2] - wp[a + 2];
    const e2x = wp[c] - wp[a],
      e2y = wp[c + 1] - wp[a + 1],
      e2z = wp[c + 2] - wp[a + 2];
    const nx = e1y * e2z - e1z * e2y,
      ny = e1z * e2x - e1x * e2z,
      nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz);
    fa[t] = l;
    if (l > 1e-20) {
      fn[t * 3] = nx / l;
      fn[t * 3 + 1] = ny / l;
      fn[t * 3 + 2] = nz / l;
    }
  }
  const vfStart = new Int32Array(W + 1);
  for (let i = 0; i < T * 3; i++) vfStart[weld[i] + 1]++;
  for (let v = 0; v < W; v++) vfStart[v + 1] += vfStart[v];
  const fill = vfStart.slice(0, W);
  const vfList = new Int32Array(T * 3);
  for (let i = 0; i < T * 3; i++) vfList[fill[weld[i]]++] = Math.floor(i / 3);
  const nrm = g.attributes.normal as THREE.BufferAttribute | undefined;
  let sn: Float32Array | null = null;
  if (nrm) {
    sn = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x = nrm.getX(i),
        y = nrm.getY(i),
        z = nrm.getZ(i);
      const l = Math.hypot(x, y, z) || 1;
      sn[i * 3] = x / l;
      sn[i * 3 + 1] = y / l;
      sn[i * 3 + 2] = z / l;
    }
  }
  return { n, weld, W, wp, fn, fa, vfStart, vfList, sn };
}

/**
 * Per-vertex dominant principal curvature (positive = convex), from normals that are smoothed only across edges
 * flatter than `sharpAngle` (like an "auto smooth" angle; see followsShading for coarse organic meshes). Sharper edges
 * are left to the sharp-edge map, so a low-poly box's faces stay flat instead of inheriting the curvature of their
 * corners, while a smooth-shaded character keeps its coarse creases in the (graded) curvature.
 * Each triangle edge gives κ = ((n_a − n_b) · (p_a − p_b)) / |p_a − p_b|².
 */
export function autoSmoothCurvature(topo: Topology, sharpAngle: number): Float32Array {
  const { n, weld, W, wp, fn, fa, vfStart, vfList } = topo;
  const T = Math.floor(n / 3);
  const cosT = Math.cos(THREE.MathUtils.degToRad(sharpAngle));
  const shading = followsShading(topo, sharpAngle);
  // Corner normals: area-weighted average of the incident faces within the smoothing angle of this face.
  const cn = new Float32Array(T * 9);
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const v = weld[t * 3 + k];
      let x = 0,
        y = 0,
        z = 0;
      for (let j = vfStart[v]; j < vfStart[v + 1]; j++) {
        const f = vfList[j];
        if (fn[f * 3] * fn[t * 3] + fn[f * 3 + 1] * fn[t * 3 + 1] + fn[f * 3 + 2] * fn[t * 3 + 2] < cosT && !(shading && smoothAt(topo, t, f, v))) continue;
        x += fn[f * 3] * fa[f];
        y += fn[f * 3 + 1] * fa[f];
        z += fn[f * 3 + 2] * fa[f];
      }
      const l = Math.hypot(x, y, z) || 1;
      const o = (t * 3 + k) * 3;
      cn[o] = x / l;
      cn[o + 1] = y / l;
      cn[o + 2] = z / l;
    }
  }
  const kmax = new Float32Array(W).fill(-Infinity);
  const kmin = new Float32Array(W).fill(Infinity);
  const ea: number[] = [];
  const eb: number[] = [];
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const ca = t * 3 + k,
        cb = t * 3 + ((k + 1) % 3);
      const i = weld[ca],
        j = weld[cb];
      if (i === j) continue;
      ea.push(i);
      eb.push(j);
      const dx = wp[i * 3] - wp[j * 3],
        dy = wp[i * 3 + 1] - wp[j * 3 + 1],
        dz = wp[i * 3 + 2] - wp[j * 3 + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 1e-12) continue;
      const dn = (cn[ca * 3] - cn[cb * 3]) * dx + (cn[ca * 3 + 1] - cn[cb * 3 + 1]) * dy + (cn[ca * 3 + 2] - cn[cb * 3 + 2]) * dz;
      const kap = dn / d2;
      if (kap > kmax[i]) kmax[i] = kap;
      if (kap < kmin[i]) kmin[i] = kap;
      if (kap > kmax[j]) kmax[j] = kap;
      if (kap < kmin[j]) kmin[j] = kap;
    }
  }
  let curv = new Float32Array(W);
  for (let i = 0; i < W; i++) {
    if (!isFinite(kmax[i])) continue;
    curv[i] = kmax[i] > -kmin[i] ? Math.max(0, kmax[i]) : Math.min(0, kmin[i]);
  }
  // Two Laplacian smoothing passes to reduce tessellation noise.
  for (let it = 0; it < 2; it++) {
    const s = new Float32Array(W);
    const c2 = new Float32Array(W);
    for (let e = 0; e < ea.length; e++) {
      s[ea[e]] += curv[eb[e]];
      c2[ea[e]]++;
      s[eb[e]] += curv[ea[e]];
      c2[eb[e]]++;
    }
    const next = new Float32Array(W);
    for (let i = 0; i < W; i++) next[i] = c2[i] ? 0.5 * curv[i] + 0.5 * (s[i] / c2[i]) : curv[i];
    curv = next;
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = curv[weld[i]];
  return out;
}

/**
 * |curvature| below which the fraction `p` of the surface area lies (log-spaced histogram, ~0.6 % resolution).
 * `curv` is per non-indexed vertex, each weighted by a third of its triangle's area.
 */
export function curvaturePercentile(topo: Topology, curv: Float32Array, p: number): number {
  const BINS = 4096,
    LO = Math.log(1e-4),
    HI = Math.log(1e6);
  const hist = new Float64Array(BINS);
  let total = 0;
  for (let i = 0; i < curv.length; i++) {
    const w = topo.fa[Math.floor(i / 3)];
    const k = Math.abs(curv[i]);
    const b = k > 1e-4 ? Math.min(BINS - 1, Math.floor(((Math.log(k) - LO) / (HI - LO)) * BINS)) : 0;
    hist[b] += w;
    total += w;
  }
  let acc = 0;
  for (let b = 0; b < BINS; b++) {
    acc += hist[b];
    if (acc >= p * total) return Math.exp(LO + ((b + 1) / BINS) * (HI - LO));
  }
  return 0;
}

/**
 * Edges whose faces meet at more than `sharpAngle` (and, on coarse smooth-shaded meshes, have split normals; see
 * followsShading), split into convex and concave ones, as segment lists (x0 y0 z0 x1 y1 z1 …). Open borders count
 * as convex.
 */
export function sharpEdges(topo: Topology, sharpAngle: number): { convex: Float32Array; concave: Float32Array } {
  const { n, weld, W, wp, fn } = topo;
  const T = Math.floor(n / 3);
  const cosT = Math.cos(THREE.MathUtils.degToRad(sharpAngle));
  const shading = followsShading(topo, sharpAngle);
  const faces = new Map<number, number[]>();
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const a = weld[t * 3 + k],
        b = weld[t * 3 + ((k + 1) % 3)];
      if (a === b) continue;
      const key = a < b ? a * W + b : b * W + a;
      const list = faces.get(key);
      if (list) list.push(t);
      else faces.set(key, [t]);
    }
  }
  const convex: number[] = [];
  const concave: number[] = [];
  for (const [key, fs] of faces) {
    const a = Math.floor(key / W),
      b = key % W;
    const seg = [wp[a * 3], wp[a * 3 + 1], wp[a * 3 + 2], wp[b * 3], wp[b * 3 + 1], wp[b * 3 + 2]];
    if (fs.length === 1) {
      convex.push(...seg);
      continue;
    }
    if (fs.length !== 2) continue; // non-manifold: skip
    const [f0, f1] = fs;
    const dot = fn[f0 * 3] * fn[f1 * 3] + fn[f0 * 3 + 1] * fn[f1 * 3 + 1] + fn[f0 * 3 + 2] * fn[f1 * 3 + 2];
    if (dot >= cosT || (shading && smoothAt(topo, f0, f1, a) && smoothAt(topo, f0, f1, b))) continue;
    // Convex when the second face's far corner lies below the first face's plane.
    let side = 0;
    for (let k = 0; k < 3; k++) {
      const v = weld[f1 * 3 + k];
      if (v === a || v === b) continue;
      side = fn[f0 * 3] * (wp[v * 3] - wp[a * 3]) + fn[f0 * 3 + 1] * (wp[v * 3 + 1] - wp[a * 3 + 1]) + fn[f0 * 3 + 2] * (wp[v * 3 + 2] - wp[a * 3 + 2]);
    }
    (side <= 0 ? convex : concave).push(...seg);
  }
  return { convex: new Float32Array(convex), concave: new Float32Array(concave) };
}

/**
 * GPU distance field source for a set of segments: each segment becomes a sliver triangle in a BVH, so
 * three-mesh-bvh's closest-point query measures the distance to the nearest segment.
 */
export function segmentBVH(segments: Float32Array): MeshBVHUniformStruct {
  const count = Math.max(1, segments.length / 6);
  const pos = new Float32Array(count * 9);
  const a = new THREE.Vector3(),
    b = new THREE.Vector3(),
    d = new THREE.Vector3(),
    p = new THREE.Vector3();
  if (!segments.length) {
    // No edges of this kind: one tiny triangle far away, so every query returns "nothing within reach".
    pos.set([1e6, 1e6, 1e6, 1e6 + 1e-3, 1e6, 1e6, 1e6, 1e6 + 1e-3, 1e6]);
  }
  for (let s = 0; s < segments.length / 6; s++) {
    a.fromArray(segments, s * 6);
    b.fromArray(segments, s * 6 + 3);
    d.subVectors(b, a);
    p.set(1, 0, 0);
    if (Math.abs(d.clone().normalize().x) > 0.9) p.set(0, 1, 0);
    p.cross(d).normalize().multiplyScalar(1e-5);
    a.toArray(pos, s * 9);
    b.toArray(pos, s * 9 + 3);
    b.add(p).toArray(pos, s * 9 + 6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const u = new MeshBVHUniformStruct();
  u.updateFrom(new MeshBVH(g));
  return u;
}
