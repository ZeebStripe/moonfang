/**
 * Projected decals (tattoos, logos, labels): an image projected onto the model by a fill layer, wrapped around a limb
 * (cylinder) or laid flat (planar), instead of being stamped into paint pixels.
 * Kept free of WebGL imports so the placement maths can be unit tested in Node.
 *
 * Positions are in the compositor's isotropic model space: (world − bboxMin) / largest bbox extent, so the model
 * spans 0..1 along its longest axis (meshA's normalised position × extentRatio).
 */

export type Vec3 = [number, number, number];

export interface DecalProjection {
  /** texture id: RGB = ink colour (sRGB), A = coverage (a decal's colour image) */
  image: string;
  /** 'wrap' bends the image around `axis`; 'flat' projects it straight along `axis` */
  mapping: 'wrap' | 'flat';
  /** wrap: a point on the cylinder axis level with the image centre; flat: the image centre on the surface */
  center: Vec3;
  /** wrap: the cylinder axis (the image's up direction); flat: the surface normal the image is projected along */
  axis: Vec3;
  /** perpendicular to `axis`: wrap: where the image centre faces, out from the axis; flat: the image's up */
  front: Vec3;
  /** wrap: the cylinder's radius where it was placed */
  radius: number;
  /** image height in model units (1 = the model's longest side) */
  size: number;
  /** width ÷ height */
  aspect: number;
  /** degrees, counter-clockwise as seen from outside */
  rotation: number;
  /** mirror the image left to right */
  flip: boolean;
  /** how far from the placed surface the projection reaches, in model units (stops it bleeding onto nearby parts) */
  reach: number;
  /** paint the image's own colours; otherwise its shape in the layer's colour (ink) */
  useImageColor: boolean;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const normalize = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-12 ? scale(a, 1 / l) : [0, 1, 0];
};
/** `v` without its component along unit `axis`, normalised (or a fallback perpendicular when they are parallel). */
export function perpendicular(v: Vec3, axis: Vec3): Vec3 {
  const p = sub(v, scale(axis, dot(v, axis)));
  if (Math.hypot(p[0], p[1], p[2]) > 1e-6) return normalize(p);
  return normalize(cross(axis, Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
}

/** Eigen-decomposition of a symmetric 3×3 matrix (Jacobi). Returns eigenvalues ascending with their unit vectors. */
export function symEigen(m: number[][]): { values: number[]; vectors: Vec3[] } {
  const a = m.map((r) => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 32; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
    if (off < 1e-20) break;
    for (let p = 0; p < 3; p++)
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
  }
  const order = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  return { values: order.map((i) => a[i][i]), vectors: order.map((i) => normalize([v[0][i], v[1][i], v[2][i]])) };
}

/** Surface samples near the click: positions and unit normals, flat arrays (xyz per point), in model units. */
export interface SurfaceSamples {
  positions: ArrayLike<number>;
  normals: ArrayLike<number>;
}

export interface CylinderFit {
  /** point on the axis level with the clicked point */
  center: Vec3;
  axis: Vec3;
  radius: number;
  /** false when the patch is nearly flat and the axis was guessed (pointing as close to `up` as possible) */
  confident: boolean;
}

/**
 * Fits a cylinder (a limb, a neck, a torso) to the surface around `hit`, using only samples within `within` of it.
 * The axis is the direction the normals don't vary in (the smallest eigenvector of Σ n nᵀ); the centre is where the
 * normal lines meet, seen down the axis. On a nearly flat patch the axis is ambiguous: it is then the direction
 * closest to `up` across the surface, with the radius guessed from `within`.
 */
export function fitCylinder(s: SurfaceSamples, hit: Vec3, hitNormal: Vec3, within: number, up: Vec3 = [0, 1, 0]): CylinderFit {
  const n0 = normalize(hitNormal);
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const idx: number[] = [];
  const r2 = within * within;
  for (let i = 0; i * 3 < s.positions.length; i++) {
    const p: Vec3 = [s.positions[i * 3], s.positions[i * 3 + 1], s.positions[i * 3 + 2]];
    const d = sub(p, hit);
    if (dot(d, d) > r2) continue;
    const n = normalize([s.normals[i * 3], s.normals[i * 3 + 1], s.normals[i * 3 + 2]]);
    // Only the side facing the same way as the click: the far side of a thin part would flip the fit.
    if (dot(n, n0) < 0) continue;
    idx.push(i);
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) M[a][b] += n[a] * n[b];
  }
  const { values, vectors } = symEigen(M);
  const spread = values[2] > 0 ? values[1] / values[2] : 0;
  const confident = idx.length >= 6 && spread > 0.04;
  const axis = confident ? orientLike(vectors[0], up) : perpendicular(up, n0);

  // Least-squares meeting point of the normal lines q − t·n, all projected onto the plane across the axis.
  const u = perpendicular(n0, axis), w = cross(axis, u);
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
  for (const i of confident ? idx : []) {
    const q = sub([s.positions[i * 3], s.positions[i * 3 + 1], s.positions[i * 3 + 2]], hit);
    const n: Vec3 = [s.normals[i * 3], s.normals[i * 3 + 1], s.normals[i * 3 + 2]];
    const d = [dot(n, u), dot(n, w)];
    const l = Math.hypot(d[0], d[1]);
    if (l < 1e-6) continue;
    d[0] /= l;
    d[1] /= l;
    const q2 = [dot(q, u), dot(q, w)];
    // (I − d dᵀ) for this line
    const m11 = 1 - d[0] * d[0], m12 = -d[0] * d[1], m22 = 1 - d[1] * d[1];
    a11 += m11;
    a12 += m12;
    a22 += m22;
    b1 += m11 * q2[0] + m12 * q2[1];
    b2 += m12 * q2[0] + m22 * q2[1];
  }
  const det = a11 * a22 - a12 * a12;
  let c2: [number, number] | null = null;
  if (confident && Math.abs(det) > 1e-9) c2 = [(a22 * b1 - a12 * b2) / det, (a11 * b2 - a12 * b1) / det];
  let radius = c2 ? Math.hypot(c2[0], c2[1]) : within * 2;
  // The centre must lie behind the clicked surface; otherwise (a saddle, noise) fall back to straight in.
  if (!c2 || c2[0] * dot(n0, u) + c2[1] * dot(n0, w) > 0) radius = within * 2;
  radius = Math.min(Math.max(radius, within * 0.25), 1);
  const center = sub(hit, scale(perpendicular(n0, axis), radius));
  return { center, axis, radius, confident };
}

const orientLike = (v: Vec3, like: Vec3): Vec3 => (dot(v, like) < 0 ? scale(v, -1) : v);

/** A new projected decal at a clicked point (model units), facing out of the surface there. */
export function placeProjection(
  image: string,
  mapping: DecalProjection['mapping'],
  hit: Vec3,
  hitNormal: Vec3,
  samples: SurfaceSamples,
  size: number,
  aspect = 1,
  up: Vec3 = [0, 1, 0],
  /** the model's middle: on a limb that isn't upright, the image's top points towards it (the shoulder, the hip) */
  towards?: Vec3,
): DecalProjection {
  const n = normalize(hitNormal);
  const base = { image, mapping, size, aspect, rotation: 0, flip: false, useImageColor: false };
  if (mapping === 'flat') {
    return { ...base, center: hit, axis: n, front: perpendicular(up, n), radius: 0, reach: size * 0.5 };
  }
  const fit = fitCylinder(samples, hit, n, size * 0.6, up);
  if (towards && Math.abs(dot(fit.axis, up)) < 0.7 && dot(fit.axis, sub(towards, hit)) < 0) fit.axis = scale(fit.axis, -1);
  return { ...base, center: fit.center, axis: fit.axis, front: perpendicular(n, fit.axis), radius: fit.radius, reach: Math.max(fit.radius * 0.6, size * 0.15) };
}

/** Moves a projected decal along its axis (wrap) or across the surface towards its up direction (flat). */
export function slideProjection(t: DecalProjection, distance: number): Vec3 {
  return add(t.center, scale(t.mapping === 'wrap' ? t.axis : t.front, distance));
}

/** Moves a flat projected decal sideways (to the image's right) across the surface. */
export function shiftProjection(t: DecalProjection, distance: number): Vec3 {
  return add(t.center, scale(cross(t.front, t.axis), distance));
}

/** Turns where a wrapped decal faces around its axis, in degrees. */
export function turnProjection(t: DecalProjection, degrees: number): Vec3 {
  const a = (degrees * Math.PI) / 180;
  const side = cross(t.axis, t.front);
  return normalize(add(scale(t.front, Math.cos(a)), scale(side, Math.sin(a))));
}

/**
 * The image coordinate (0..1 inside the image) of a surface point `p` with unit normal `n`, and its coverage weight
 * (0 where the projection doesn't apply: behind, too far, or facing away). Mirrors the shader in compositor.ts.
 */
export function projectionUV(t: DecalProjection, p: Vec3, n: Vec3): { uv: [number, number]; weight: number } {
  const d = sub(p, t.center);
  let x: number, y: number, weight: number;
  if (t.mapping === 'wrap') {
    const h = dot(d, t.axis);
    const q = sub(d, scale(t.axis, h));
    const dist = Math.hypot(q[0], q[1], q[2]);
    const side = cross(t.axis, t.front);
    const ang = Math.atan2(dot(q, side), dot(q, t.front));
    x = ang * dist;
    y = h;
    const out = dist > 1e-6 ? dot(n, scale(q, 1 / dist)) : 0;
    weight = smooth(0, 0.25, out) * (1 - smooth(t.reach * 0.7, t.reach, Math.abs(dist - t.radius)));
  } else {
    const z = dot(d, t.axis);
    const side = cross(t.front, t.axis);
    x = dot(d, side);
    y = dot(d, t.front);
    weight = smooth(0, 0.25, dot(n, t.axis)) * (1 - smooth(t.reach * 0.7, t.reach, Math.abs(z)));
  }
  const r = (t.rotation * Math.PI) / 180;
  const xr = Math.cos(r) * x + Math.sin(r) * y, yr = -Math.sin(r) * x + Math.cos(r) * y;
  const u = (t.flip ? -xr : xr) / (t.size * t.aspect) + 0.5;
  const v = yr / t.size + 0.5;
  return { uv: [u, v], weight };
}

function smooth(e0: number, e1: number, x: number) {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}
