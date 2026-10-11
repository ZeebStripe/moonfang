import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MeshBVHUniformStruct } from 'three-mesh-bvh';
import { autoSmoothCurvature, buildTopology, segmentBVH, sharpEdges, type Topology } from './meshAnalysis';

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
  /** Raw per-vertex curvature (normalised space); mapped to the `curv` attribute by applyCurvatureGain. */
  curvRaw: Float32Array;
  /** sharp-edge angle curvRaw was computed with */
  curvAngle: number;
  topology: Topology;
  /** GPU distance sources for the sharp convex / concave edges at `angle` (see meshEdges) */
  edgeCache?: { angle: number; convex: MeshBVHUniformStruct; concave: MeshBVHUniformStruct; count: number };
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

/** Parses a model file into a scene graph (.glb, embedded .gltf, .obj, .fbx). */
export async function parseModel(name: string, bytes: ArrayBuffer): Promise<THREE.Object3D> {
  const ext = name.split('.').pop()!.toLowerCase();
  // Loaders are fetched on first use; the demo meshes need none of them.
  if (ext === 'glb' || ext === 'gltf') {
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    return (await new GLTFLoader().parseAsync(bytes, '')).scene;
  }
  if (ext === 'obj') {
    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
    return new OBJLoader().parse(new TextDecoder().decode(bytes));
  }
  if (ext === 'fbx') {
    const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
    return new FBXLoader().parse(bytes, '');
  }
  throw new Error(`Unsupported mesh format '.${ext}'. Use .glb, .gltf (embedded), .obj or .fbx.`);
}

export async function loadMeshFile(name: string, bytes: ArrayBuffer): Promise<PaintMesh> {
  const root = await parseModel(name, bytes);
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
  // Total UV area: zero means the model was never unwrapped (all UVs collapsed to a point or line).
  let uvArea = 0;
  for (let i = 0; i + 2 < uv.count; i += 3) {
    const ax = uv.getX(i), ay = uv.getY(i);
    uvArea += Math.abs((uv.getX(i + 1) - ax) * (uv.getY(i + 2) - ay) - (uv.getX(i + 2) - ax) * (uv.getY(i + 1) - ay)) / 2;
  }
  if (uvArea < 1e-4) warnings.push('This model has no usable UV layout (its UVs are collapsed), so nothing can be painted. Unwrap it first (e.g. Smart UV Project in Blender).');

  g.computeBoundingSphere();
  const center = g.boundingSphere!.center.clone();
  const scale = 1 / (g.boundingSphere!.radius || 1);
  g.translate(-center.x, -center.y, -center.z);
  g.scale(scale, scale, scale);
  g.computeBoundingBox();
  g.computeBoundingSphere();

  const topology = buildTopology(g);
  const curvAngle = DEFAULT_SHARP_ANGLE;
  const curvRaw = autoSmoothCurvature(topology, curvAngle);
  g.setAttribute('curv', new THREE.BufferAttribute(new Float32Array(curvRaw.length), 1));
  const mesh: PaintMesh = { name, geometry: g, source, center, scale, bbox: g.boundingBox!.clone(), curvRaw, curvAngle, topology, warnings, sets };
  applyCurvatureGain(mesh, 1);
  return mesh;
}

export const DEFAULT_SHARP_ANGLE = 35;

/** Recomputes the vertex curvature for another sharp-edge angle (edges sharper than it go to the edge map). */
export function setSharpAngle(mesh: PaintMesh, angle: number) {
  if (mesh.curvAngle === angle) return;
  mesh.curvRaw = autoSmoothCurvature(mesh.topology, angle);
  mesh.curvAngle = angle;
}

/** Sharp convex / concave edges as GPU distance sources (cached per angle). */
export function meshEdges(mesh: PaintMesh, angle: number) {
  if (mesh.edgeCache?.angle !== angle) {
    disposeMeshEdges(mesh);
    const e = sharpEdges(mesh.topology, angle);
    mesh.edgeCache = { angle, convex: segmentBVH(e.convex), concave: segmentBVH(e.concave), count: (e.convex.length + e.concave.length) / 6 };
  }
  return mesh.edgeCache!;
}

export function disposeMeshEdges(mesh: PaintMesh) {
  mesh.edgeCache?.convex.dispose();
  mesh.edgeCache?.concave.dispose();
  mesh.edgeCache = undefined;
}

/** Maps raw curvature to 0..1 (0.5 = flat, >0.5 convex) with a soft tanh curve. */
export function applyCurvatureGain(mesh: PaintMesh, gain: number) {
  const attr = mesh.geometry.attributes.curv as THREE.BufferAttribute;
  const k = 0.1 * gain;
  for (let i = 0; i < mesh.curvRaw.length; i++) attr.setX(i, 0.5 + 0.5 * Math.tanh(mesh.curvRaw[i] * k));
  attr.needsUpdate = true;
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
