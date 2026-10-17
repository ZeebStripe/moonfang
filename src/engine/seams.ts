/**
 * UV seam bridges. Kept free of WebGL imports so it can be unit tested in Node.
 *
 * A UV seam is a mesh edge whose two triangles sit in different places in UV space. For each side of such an edge
 * this builds a strip just outside that side's island: every point of the strip stores the UV of the same surface
 * point continued across the seam into the other island. Rasterised into a "twin" map, it lets texture-space filters
 * (the height → normal step, padding) read across seams instead of reading a copy of the island's own edge.
 */

export interface SeamStrips {
  /** per vertex: strip position in UV (x, y) and distance from the seam edge 0..1 (z, used as depth) */
  position: Float32Array;
  /** per vertex: the twin UV on the other side of the seam */
  twin: Float32Array;
  /** number of seam edges found (each produces two strips, one per side) */
  seamEdges: number;
}

type V2 = [number, number];

/**
 * @param positions xyz per vertex
 * @param uvs       uv per vertex
 * @param index     triangle indices, or null for a non-indexed geometry
 * @param width     strip width in UV units (a few texels)
 */
export function buildSeamStrips(positions: ArrayLike<number>, uvs: ArrayLike<number>, index: ArrayLike<number> | null, width: number): SeamStrips {
  const vertCount = positions.length / 3;
  const triCount = index ? index.length / 3 : vertCount / 3;
  const vi = (t: number, k: number) => (index ? index[t * 3 + k] : t * 3 + k);

  // Vertices welded by position (the UVs differ across a seam, so the index alone does not connect the two sides).
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < positions.length; i++) {
    min = Math.min(min, positions[i]);
    max = Math.max(max, positions[i]);
  }
  const q = 1e5 / Math.max(max - min, 1e-9);
  const keyIds = new Map<string, number>();
  const posId = new Int32Array(vertCount);
  for (let v = 0; v < vertCount; v++) {
    const key = `${Math.round(positions[v * 3] * q)},${Math.round(positions[v * 3 + 1] * q)},${Math.round(positions[v * 3 + 2] * q)}`;
    let id = keyIds.get(key);
    if (id === undefined) keyIds.set(key, (id = keyIds.size));
    posId[v] = id;
  }

  interface Side { a: number; b: number; c: number }
  const edges = new Map<string, Side[]>();
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const a = vi(t, k);
      const b = vi(t, (k + 1) % 3);
      const c = vi(t, (k + 2) % 3);
      const pa = posId[a];
      const pb = posId[b];
      if (pa === pb) continue;
      const key = pa < pb ? `${pa}_${pb}` : `${pb}_${pa}`;
      let list = edges.get(key);
      if (!list) edges.set(key, (list = []));
      list.push({ a, b, c });
    }
  }

  const uv = (v: number): V2 => [uvs[v * 2], uvs[v * 2 + 1]];
  const same = (p: V2, r: V2) => Math.abs(p[0] - r[0]) < 1e-6 && Math.abs(p[1] - r[1]) < 1e-6;
  const pos: number[] = [];
  const twin: number[] = [];
  let seamEdges = 0;

  /** Strip outside side `s` (edge a→b, third vertex c), mapped onto side `o` across the seam. */
  const strip = (s: Side, o: Side) => {
    // Match o's ends to s's ends by position.
    const [oa, ob] = posId[o.a] === posId[s.a] ? [o.a, o.b] : [o.b, o.a];
    const a0 = uv(s.a), a1 = uv(s.b), ac = uv(s.c);
    const b0 = uv(oa), b1 = uv(ob), bc = uv(o.c);
    const la = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]);
    const lb = Math.hypot(b1[0] - b0[0], b1[1] - b0[1]);
    if (la < 1e-9 || lb < 1e-9) return;
    // Outward normal on s's side (away from its third vertex), inward normal on o's side (towards its third vertex).
    const nA = awayFrom([-(a1[1] - a0[1]) / la, (a1[0] - a0[0]) / la], a0, ac, -1);
    const nB = awayFrom([-(b1[1] - b0[1]) / lb, (b1[0] - b0[0]) / lb], b0, bc, 1);
    const wb = width * (lb / la);  // keep the strip's proportions in the other island's texel density
    const corner = (t: number, d: number) => {
      pos.push(a0[0] + (a1[0] - a0[0]) * t + nA[0] * width * d, a0[1] + (a1[1] - a0[1]) * t + nA[1] * width * d, d);
      twin.push(b0[0] + (b1[0] - b0[0]) * t + nB[0] * wb * d, b0[1] + (b1[1] - b0[1]) * t + nB[1] * wb * d);
    };
    // Two triangles: (0,0) (1,0) (1,1) and (0,0) (1,1) (0,1) in (along edge, away from edge).
    corner(0, 0), corner(1, 0), corner(1, 1);
    corner(0, 0), corner(1, 1), corner(0, 1);
  };

  for (const list of edges.values()) {
    if (list.length !== 2) continue;  // open boundary or non-manifold
    const [s, o] = list;
    const [oa, ob] = posId[o.a] === posId[s.a] ? [o.a, o.b] : [o.b, o.a];
    if (same(uv(s.a), uv(oa)) && same(uv(s.b), uv(ob))) continue;  // connected in UV: not a seam
    seamEdges++;
    strip(s, o);
    strip(o, s);
  }
  return { position: new Float32Array(pos), twin: new Float32Array(twin), seamEdges };
}

/** `n` flipped so it points towards (sign 1) or away from (sign −1) the third vertex `c`, seen from `p`. */
function awayFrom(n: V2, p: V2, c: V2, sign: number): V2 {
  const d = (c[0] - p[0]) * n[0] + (c[1] - p[1]) * n[1];
  return d * sign >= 0 ? n : [-n[0], -n[1]];
}
