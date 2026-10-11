import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type MeshSource =
  | { kind: 'demo'; id: DemoMeshId }
  | { kind: 'file'; name: string; bytes: ArrayBuffer };

export interface PaintMesh {
  name: string;
  /** Normalised geometry (centered, bounding radius 1). Non-indexed, attributes: position, normal, uv, curv. */
  geometry: THREE.BufferGeometry;
  source: MeshSource;
  /** Original-space transform: original = normalised / scale + center. */
  center: THREE.Vector3;
  scale: number;
  bbox: THREE.Box3;
  /** Raw per-vertex mean curvature (normalised space); mapped to the `curv` attribute by applyCurvatureGain. */
  curvRaw: Float32Array;
  warnings: string[];
  /** texture sets (one per source material), in vertex order */
  sets: TextureSetInfo[];
}

export type DemoMeshId = 'roundedCube' | 'vase' | 'torusKnot' | 'sphere' | 'twoSets';
export const DEMO_MESHES: { id: DemoMeshId; label: string }[] = [
  { id: 'roundedCube', label: 'Rounded Cube' },
  { id: 'twoSets', label: 'Cube + Gem (2 texture sets)' },
  { id: 'vase', label: 'Vase' },
  { id: 'torusKnot', label: 'Torus Knot' },
  { id: 'sphere', label: 'Sphere' },
];

export async function loadMeshFile(name: string, bytes: ArrayBuffer): Promise<PaintMesh> {
  const ext = name.split('.').pop()!.toLowerCase();
  let root: THREE.Object3D;
  if (ext === 'glb' || ext === 'gltf') {
    const gltf = await new GLTFLoader().parseAsync(bytes, '');
    root = gltf.scene;
  } else if (ext === 'obj') {
    root = new OBJLoader().parse(new TextDecoder().decode(bytes));
  } else if (ext === 'fbx') {
    root = new FBXLoader().parse(bytes, '');
  } else {
    throw new Error(`Unsupported mesh format ".${ext}". Use .glb, .gltf (embedded), .obj or .fbx.`);
  }
  const warnings: string[] = [];
  const { geometry, sets } = collectGeometry(root, warnings);
  return buildPaintMesh(name.replace(/\.[^.]+$/, ''), geometry, { kind: 'file', name, bytes }, warnings, sets);
}

export function loadDemoMesh(id: DemoMeshId): PaintMesh {
  let g: THREE.BufferGeometry;
  switch (id) {
    case 'roundedCube':
      g = roundedCube(0.14);
      break;
    case 'vase':
      g = vase();
      break;
    case 'torusKnot':
      g = new THREE.TorusKnotGeometry(1, 0.34, 360, 40);
      break;
    case 'sphere':
      g = new THREE.SphereGeometry(1, 96, 64);
      break;
    case 'twoSets': {
      const body = roundedCube(0.14).toNonIndexed();
      const gem = new THREE.IcosahedronGeometry(0.55, 3); // already non-indexed
      gem.translate(0, 1.6, 0);
      const merged = mergeGeometries([body, gem], false)!;
      const label = DEMO_MESHES.find((d) => d.id === id)!.label;
      const n = body.attributes.position.count;
      return buildPaintMesh(label, merged, { kind: 'demo', id }, [], [
        { name: 'Body', start: 0, count: n },
        { name: 'Gem', start: n, count: gem.attributes.position.count },
      ]);
    }
  }
  const label = DEMO_MESHES.find((d) => d.id === id)!.label;
  return buildPaintMesh(label, g, { kind: 'demo', id }, []);
}

export async function loadMeshSource(src: MeshSource): Promise<PaintMesh> {
  return src.kind === 'demo' ? loadDemoMesh(src.id) : loadMeshFile(src.name, src.bytes);
}

/** One texture set = one material of the source model; a contiguous vertex range of the merged geometry. */
export interface TextureSetInfo {
  name: string;
  start: number;
  count: number;
}

interface Part {
  geometry: THREE.BufferGeometry;
  key: string;
  name: string;
}

/** Vertex sub-range of a non-indexed geometry (position / normal / uv only). */
function sliceGeometry(g: THREE.BufferGeometry, start: number, count: number): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const key of ['position', 'normal', 'uv'] as const) {
    const a = g.attributes[key] as THREE.BufferAttribute;
    const f = new Float32Array(count * a.itemSize);
    for (let i = 0; i < count; i++) for (let c = 0; c < a.itemSize; c++) f[i * a.itemSize + c] = a.getComponent(start + i, c);
    out.setAttribute(key, new THREE.BufferAttribute(f, a.itemSize));
  }
  return out;
}

/** Merges all meshes, grouped by material: each distinct material becomes a texture set. */
function collectGeometry(root: THREE.Object3D, warnings: string[]): { geometry: THREE.BufferGeometry; sets: TextureSetInfo[] } {
  root.updateMatrixWorld(true);
  const parts: Part[] = [];
  let missingUv = 0;
  const names = new Map<string, string>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const src = mesh.geometry;
    if (!src.attributes.uv) {
      missingUv++;
      return;
    }
    let g = new THREE.BufferGeometry();
    g.setAttribute('position', src.attributes.position.clone());
    if (src.attributes.normal) g.setAttribute('normal', src.attributes.normal.clone());
    g.setAttribute('uv', src.attributes.uv.clone());
    if (src.index) g.setIndex(src.index.clone());
    for (const gr of src.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
    g = g.index ? g.toNonIndexed() : g; // keeps groups; their ranges now index vertices
    g.applyMatrix4(mesh.matrixWorld);
    if (!g.attributes.normal) g.computeVertexNormals();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const ranges = g.groups.length && Array.isArray(mesh.material) ? g.groups : [{ start: 0, count: g.attributes.position.count, materialIndex: 0 }];
    for (const r of ranges) {
      const m = mats[r.materialIndex ?? 0] ?? mats[0];
      const key = m ? (m.name ? `name:${m.name}` : m.uuid) : 'none';
      if (!names.has(key)) names.set(key, m?.name || `Material ${names.size + 1}`);
      const count = Math.min(r.count, g.attributes.position.count - r.start);
      if (count > 0) parts.push({ geometry: ranges.length === 1 ? g : sliceGeometry(g, r.start, count), key, name: names.get(key)! });
    }
  });
  if (missingUv) warnings.push(`${missingUv} mesh part(s) without UVs were skipped. Unwrap them first (e.g. in Blender).`);
  if (!parts.length) throw new Error('No meshes with UV coordinates found in this file.');
  // Normalise attribute item sizes / types so merge succeeds.
  for (const { geometry: p } of parts) {
    for (const key of ['position', 'normal', 'uv'] as const) {
      const a = p.attributes[key] as THREE.BufferAttribute;
      if (!(a.array instanceof Float32Array) || a.normalized) {
        const f = new Float32Array(a.count * a.itemSize);
        for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) f[i * a.itemSize + c] = a.getComponent(i, c);
        p.setAttribute(key, new THREE.BufferAttribute(f, a.itemSize));
      }
    }
    for (const k of Object.keys(p.attributes)) if (!['position', 'normal', 'uv'].includes(k)) p.deleteAttribute(k);
    p.clearGroups();
  }
  // Order parts by set (first appearance) so each set is one contiguous range.
  const order = [...names.keys()];
  parts.sort((x, y) => order.indexOf(x.key) - order.indexOf(y.key));
  const sets: TextureSetInfo[] = [];
  let start = 0;
  for (const key of order) {
    const count = parts.filter((x) => x.key === key).reduce((n, x) => n + x.geometry.attributes.position.count, 0);
    sets.push({ name: names.get(key)!, start, count });
    start += count;
  }
  const merged = parts.length === 1 ? parts[0].geometry : mergeGeometries(parts.map((x) => x.geometry), false);
  if (!merged) throw new Error('Failed to merge mesh parts.');
  if (sets.length > 1) warnings.push(`Model has ${sets.length} materials — each is its own texture set (switch sets above the layer stack).`);
  return { geometry: merged, sets };
}

function buildPaintMesh(name: string, geometry: THREE.BufferGeometry, source: MeshSource, warnings: string[], sets?: TextureSetInfo[]): PaintMesh {
  let g = geometry.index ? geometry.toNonIndexed() : geometry;
  // Keep only the attributes we need.
  const clean = new THREE.BufferGeometry();
  clean.setAttribute('position', g.attributes.position);
  clean.setAttribute('normal', g.attributes.normal);
  clean.setAttribute('uv', g.attributes.uv);
  g = clean;
  sets ??= [{ name: 'Main', start: 0, count: g.attributes.position.count }];
  // Groups let the viewport draw each texture set with its own material.
  sets.forEach((st, i) => g.addGroup(st.start, st.count, i));

  const uv = g.attributes.uv as THREE.BufferAttribute;
  let outside = 0;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i);
    const v = uv.getY(i);
    if (u < -0.001 || u > 1.001 || v < -0.001 || v > 1.001) outside++;
  }
  if (outside > uv.count * 0.01) warnings.push('Some UVs lie outside the 0–1 range; those areas cannot be painted.');

  g.computeBoundingSphere();
  const center = g.boundingSphere!.center.clone();
  const scale = 1 / (g.boundingSphere!.radius || 1);
  g.translate(-center.x, -center.y, -center.z);
  g.scale(scale, scale, scale);
  g.computeBoundingBox();
  g.computeBoundingSphere();

  const curvRaw = computeCurvature(g);
  g.setAttribute('curv', new THREE.BufferAttribute(new Float32Array(curvRaw.length), 1));
  const mesh: PaintMesh = { name, geometry: g, source, center, scale, bbox: g.boundingBox!.clone(), curvRaw, warnings, sets };
  applyCurvatureGain(mesh, 1);
  return mesh;
}

/** Maps raw curvature to 0..1 (0.5 = flat, >0.5 convex) with a soft tanh curve. */
export function applyCurvatureGain(mesh: PaintMesh, gain: number) {
  const attr = mesh.geometry.attributes.curv as THREE.BufferAttribute;
  const k = 0.1 * gain;
  for (let i = 0; i < mesh.curvRaw.length; i++) attr.setX(i, 0.5 + 0.5 * Math.tanh(mesh.curvRaw[i] * k));
  attr.needsUpdate = true;
}

/**
 * Per-vertex dominant principal curvature on the welded mesh. Each edge gives a normal-curvature sample
 * κ_ij = ((n_i - n_j) · (p_i - p_j)) / |p_i - p_j|²  (1/R on a sphere of radius R, positive when convex);
 * the vertex keeps whichever of max(κ) / min(κ) has the larger magnitude, so cylindrical bevels register as
 * strongly as spherical corners.
 */
function computeCurvature(g: THREE.BufferGeometry): Float32Array {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const n = pos.count;
  const weld = new Int32Array(n);
  const map = new Map<string, number>();
  const wp: number[] = [];
  const q = 1e5;
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i),
      y = pos.getY(i),
      z = pos.getZ(i);
    const key = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = wp.length / 3;
      map.set(key, id);
      wp.push(x, y, z);
    }
    weld[i] = id;
  }
  const W = wp.length / 3;
  // Area-weighted smooth normals on the welded topology.
  const wn = new Float32Array(W * 3);
  const a = new THREE.Vector3(),
    b = new THREE.Vector3(),
    c = new THREE.Vector3(),
    e1 = new THREE.Vector3(),
    e2 = new THREE.Vector3();
  for (let t = 0; t < n; t += 3) {
    a.fromBufferAttribute(pos, t);
    b.fromBufferAttribute(pos, t + 1);
    c.fromBufferAttribute(pos, t + 2);
    e1.subVectors(b, a);
    e2.subVectors(c, a);
    e1.cross(e2);
    for (let k = 0; k < 3; k++) {
      const id = weld[t + k];
      wn[id * 3] += e1.x;
      wn[id * 3 + 1] += e1.y;
      wn[id * 3 + 2] += e1.z;
    }
  }
  for (let i = 0; i < W; i++) {
    const l = Math.hypot(wn[i * 3], wn[i * 3 + 1], wn[i * 3 + 2]) || 1;
    wn[i * 3] /= l;
    wn[i * 3 + 1] /= l;
    wn[i * 3 + 2] /= l;
  }
  // Edge list on welded ids.
  const ea: number[] = [];
  const eb: number[] = [];
  for (let t = 0; t < n; t += 3) {
    for (let k = 0; k < 3; k++) {
      const i0 = weld[t + k];
      const i1 = weld[t + ((k + 1) % 3)];
      if (i0 !== i1) {
        ea.push(i0);
        eb.push(i1);
      }
    }
  }
  const kmax = new Float32Array(W).fill(-Infinity);
  const kmin = new Float32Array(W).fill(Infinity);
  for (let e = 0; e < ea.length; e++) {
    const i = ea[e],
      j = eb[e];
    const dx = wp[i * 3] - wp[j * 3],
      dy = wp[i * 3 + 1] - wp[j * 3 + 1],
      dz = wp[i * 3 + 2] - wp[j * 3 + 2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < 1e-12) continue;
    const dn = (wn[i * 3] - wn[j * 3]) * dx + (wn[i * 3 + 1] - wn[j * 3 + 1]) * dy + (wn[i * 3 + 2] - wn[j * 3 + 2]) * dz;
    const k = dn / d2;
    if (k > kmax[i]) kmax[i] = k;
    if (k < kmin[i]) kmin[i] = k;
    if (k > kmax[j]) kmax[j] = k;
    if (k < kmin[j]) kmin[j] = k;
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

/** Cube with rounded edges; each face gets its own square cell in a 3x2 UV atlas. */
function roundedCube(r: number): THREE.BufferGeometry {
  const coords: number[] = [];
  const B = 10,
    M = 24;
  for (let i = 0; i <= B; i++) coords.push(-1 + (r * i) / B);
  for (let i = 1; i < M; i++) coords.push(-1 + r + ((2 - 2 * r) * i) / M);
  for (let i = 0; i <= B; i++) coords.push(1 - r + (r * i) / B);
  const N = coords.length;
  const faces: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [
    [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0)],
    [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)],
    [new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1)],
    [new THREE.Vector3(0, -1, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)],
    [new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)],
    [new THREE.Vector3(0, 0, -1), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0)],
  ];
  const cell = 0.315;
  const pad = (1 - 3 * cell) / 4;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const inner = 1 - r;
  const p = new THREE.Vector3();
  const qv = new THREE.Vector3();
  faces.forEach(([nrm, u, v], f) => {
    const col = f % 3;
    const row = Math.floor(f / 3);
    const ox = pad + col * (cell + pad);
    const oy = 0.5 - pad / 2 - cell + row * (cell + pad);
    const base = positions.length / 3;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        p.copy(nrm).addScaledVector(u, coords[i]).addScaledVector(v, coords[j]);
        qv.set(
          THREE.MathUtils.clamp(p.x, -inner, inner),
          THREE.MathUtils.clamp(p.y, -inner, inner),
          THREE.MathUtils.clamp(p.z, -inner, inner),
        );
        const d = p.clone().sub(qv).normalize();
        const out = qv.clone().addScaledVector(d, r);
        positions.push(out.x, out.y, out.z);
        normals.push(d.x, d.y, d.z);
        uvs.push(ox + ((coords[i] + 1) / 2) * cell, oy + ((coords[j] + 1) / 2) * cell);
      }
    }
    for (let j = 0; j < N - 1; j++) {
      for (let i = 0; i < N - 1; i++) {
        const a = base + j * N + i;
        const b = a + 1;
        const c = a + N + 1;
        const d = a + N;
        indices.push(a, b, c, a, c, d);
      }
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  return g;
}

/** Lathe vase with grooves (good for dirt / cavity generators). */
function vase(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const steps = 160;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const y = -1 + 2 * t;
    let rad = 0.42 + 0.3 * Math.sin(t * Math.PI * 1.1 + 0.15) - 0.22 * Math.pow(Math.max(0, t - 0.7) / 0.3, 2);
    // Grooves / rings
    const ring = (c: number, w: number, d: number) => -d * Math.exp(-Math.pow((t - c) / w, 2));
    rad += ring(0.22, 0.012, 0.035) + ring(0.26, 0.012, 0.035) + ring(0.62, 0.015, 0.04) + ring(0.9, 0.02, -0.05);
    pts.push(new THREE.Vector2(Math.max(0.05, rad), y));
  }
  // Close the bottom.
  pts.unshift(new THREE.Vector2(0.001, -1));
  return new THREE.LatheGeometry(pts, 128);
}
