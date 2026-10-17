import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSeamStrips } from '../src/engine/seams.ts';

// A unit square in 3D (z = 0) made of two triangles sharing the diagonal edge (0,0,0)–(1,1,0).
const POS = [0, 0, 0, 1, 0, 0, 1, 1, 0, /* second triangle */ 0, 0, 0, 1, 1, 0, 0, 1, 0];

test('triangles that also share the edge in UV are not a seam', () => {
  const uv = [0, 0, 0.5, 0, 0.5, 0.5, 0, 0, 0.5, 0.5, 0, 0.5];
  assert.equal(buildSeamStrips(POS, uv, null, 0.01).seamEdges, 0);
});

// Same mesh, but the second triangle is moved (and mirrored) to its own island.
const SPLIT_UV = [0, 0, 0.4, 0, 0.4, 0.4, /* island 2 */ 0.9, 0.5, 0.5, 0.9, 0.9, 0.9];

test('a split edge becomes one seam with a strip on each side', () => {
  const s = buildSeamStrips(POS, SPLIT_UV, null, 0.01);
  assert.equal(s.seamEdges, 1);
  assert.equal(s.position.length, 2 * 6 * 3, 'two strips of two triangles');
  assert.equal(s.twin.length, 2 * 6 * 2);
});

test('the strip starts on the seam edge and maps onto the matching edge of the other island', () => {
  const s = buildSeamStrips(POS, SPLIT_UV, null, 0.01);
  // Vertices on the edge (depth 0) map to the same surface point's UV in the other island.
  const pairs = new Map([['0,0', '0.9,0.5'], ['0.4,0.4', '0.5,0.9'], ['0.9,0.5', '0,0'], ['0.5,0.9', '0.4,0.4']]);
  for (let v = 0; v < s.position.length / 3; v++) {
    if (s.position[v * 3 + 2] !== 0) continue;
    const at = `${+s.position[v * 3].toFixed(4)},${+s.position[v * 3 + 1].toFixed(4)}`;
    const to = `${+s.twin[v * 2].toFixed(4)},${+s.twin[v * 2 + 1].toFixed(4)}`;
    assert.equal(pairs.get(at), to, `edge vertex ${at}`);
  }
});

const inTri = (p, a, b, c) => {
  const s = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const d1 = s(p, a, b), d2 = s(p, b, c), d3 = s(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};

test('strips lie outside their own island and their twins land inside the other one', () => {
  const s = buildSeamStrips(POS, SPLIT_UV, null, 0.01);
  const tri1 = [[0, 0], [0.4, 0], [0.4, 0.4]];
  const tri2 = [[0.9, 0.5], [0.5, 0.9], [0.9, 0.9]];
  // Each strip is 6 vertices; vertices 2 and 5 are its far corners (along 1 and 0, away 1). Their midpoint is the
  // middle of the strip's outer edge. (At the corners themselves a perpendicular step can leave an acute triangle,
  // which on a real mesh lands on the neighbouring triangle or falls back to the nearest-texel padding.)
  const mid = (arr, n, a, b) => [0, 1].map((k) => (arr[a * n + k] + arr[b * n + k]) / 2);
  for (let strip = 0; strip < 2; strip++) {
    const p = mid(s.position, 3, strip * 6 + 2, strip * 6 + 5);
    const t = mid(s.twin, 2, strip * 6 + 2, strip * 6 + 5);
    const [own, other] = inTri(mid(s.position, 3, strip * 6, strip * 6 + 1), ...tri1) ? [tri1, tri2] : [tri2, tri1];
    assert.ok(!inTri(p, ...own), `strip middle ${p} is outside its island`);
    assert.ok(inTri(t, ...other), `twin ${t} is inside the other island`);
  }
});

test('indexed geometry with duplicated seam vertices is welded by position', () => {
  // Vertices 0..2 for triangle 1, 3..5 for triangle 2 (duplicates at the shared corners), indexed.
  const s = buildSeamStrips(POS, SPLIT_UV, [0, 1, 2, 3, 4, 5], 0.01);
  assert.equal(s.seamEdges, 1);
});

test('open boundary edges are not seams', () => {
  const s = buildSeamStrips(POS.slice(0, 9), SPLIT_UV.slice(0, 6), null, 0.01);
  assert.equal(s.seamEdges, 0);
});
