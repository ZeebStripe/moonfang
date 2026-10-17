import assert from 'node:assert/strict';
import test from 'node:test';
import { fitCylinder, placeProjection, slideProjection, symEigen, projectionUV, turnProjection } from '../src/engine/decalProjection.ts';

const close = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;
const norm = (v) => {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
};

/** Points and normals on a cylinder of `radius` around the line through `c` along unit `axis`. */
function cylinder(c, axis, radius, length, rings = 40, segs = 48) {
  const a = norm(axis);
  const crossP = (x, y) => [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  const u = norm(crossP(a, Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
  const w = norm(crossP(a, u));
  const positions = [], normals = [];
  for (let i = 0; i < rings; i++) {
    const h = (i / (rings - 1) - 0.5) * length;
    for (let j = 0; j < segs; j++) {
      const t = (j / segs) * Math.PI * 2;
      const n = [0, 1, 2].map((k) => Math.cos(t) * u[k] + Math.sin(t) * w[k]);
      positions.push(...[0, 1, 2].map((k) => c[k] + a[k] * h + n[k] * radius));
      normals.push(...n);
    }
  }
  return { positions, normals, u, w, a };
}

test('symmetric eigen-decomposition sorts eigenvalues ascending', () => {
  const { values, vectors } = symEigen([[2, 0, 0], [0, 5, 0], [0, 0, 1]]);
  assert.deepEqual(values.map((x) => Math.round(x)), [1, 2, 5]);
  assert.ok(close(Math.abs(vectors[0][2]), 1));
});

test('a tilted limb is fitted: axis, centre and radius', () => {
  const axis = norm([0.3, 1, 0.2]);
  const c = [0.4, 0.5, 0.3];
  const cyl = cylinder(c, axis, 0.04, 0.5);
  const hit = [0, 1, 2].map((k) => c[k] + cyl.u[k] * 0.04);
  const fit = fitCylinder(cyl, hit, cyl.u, 0.05);
  assert.ok(fit.confident);
  assert.ok(close(Math.abs(fit.axis[0] * axis[0] + fit.axis[1] * axis[1] + fit.axis[2] * axis[2]), 1, 1e-3), 'axis');
  assert.ok(fit.axis[1] > 0, 'axis points up like the model');
  assert.ok(close(fit.radius, 0.04, 2e-3), `radius ${fit.radius}`);
  assert.ok(Math.hypot(...fit.center.map((x, k) => x - c[k])) < 3e-3, 'centre on the axis');
});

test('a flat patch falls back to an upright axis across the surface', () => {
  const positions = [], normals = [];
  for (let i = -5; i <= 5; i++) for (let j = -5; j <= 5; j++) positions.push(i * 0.01, j * 0.01, 0), normals.push(0, 0, 1);
  const fit = fitCylinder({ positions, normals }, [0, 0, 0], [0, 0, 1], 0.05);
  assert.equal(fit.confident, false);
  assert.deepEqual(fit.axis.map((x) => Math.round(x * 1000) / 1000), [0, 1, 0]);
  assert.ok(fit.center[2] < 0, 'centre behind the surface');
});

test('a wrapped tattoo centres where it was placed and wraps around the limb', () => {
  const cyl = cylinder([0, 0, 0], [0, 1, 0], 0.05, 0.6);
  const hit = cyl.u.map((x) => x * 0.05);
  const t = placeProjection('img', 'wrap', hit, cyl.u, cyl, 0.1);
  const at = (deg, h = 0) => {
    const r = (deg * Math.PI) / 180;
    const side = [t.axis[1] * t.front[2] - t.axis[2] * t.front[1], t.axis[2] * t.front[0] - t.axis[0] * t.front[2], t.axis[0] * t.front[1] - t.axis[1] * t.front[0]];
    const n = [0, 1, 2].map((k) => Math.cos(r) * t.front[k] + Math.sin(r) * side[k]);
    return projectionUV(t, [0, 1, 2].map((k) => n[k] * 0.05 + t.axis[k] * h + t.center[k]), n);
  };
  const mid = at(0);
  assert.ok(close(mid.uv[0], 0.5) && close(mid.uv[1], 0.5) && close(mid.weight, 1));
  // 0.1 wide on a 0.05 radius: the image's right edge is 1 radian (57°) round to the right.
  assert.ok(close(at(57.2958).uv[0], 1, 2e-3));
  assert.ok(at(30).uv[0] > 0.5 && at(-30).uv[0] < 0.5, 'image right is to the right seen from outside');
  assert.ok(close(at(0, 0.05).uv[1], 1), 'image top follows the axis');
  const back = at(180).uv[0];
  assert.ok(back < 0 || back > 1, 'the back of the limb is outside the image');
});

test('the projection stops at its reach and on surfaces facing away', () => {
  const t = placeProjection('img', 'flat', [0, 0, 0], [0, 0, 1], { positions: [], normals: [] }, 0.1);
  assert.ok(close(projectionUV(t, [0, 0, 0], [0, 0, 1]).weight, 1));
  assert.equal(projectionUV(t, [0, 0, -0.2], [0, 0, 1]).weight, 0, 'too deep');
  assert.equal(projectionUV(t, [0, 0, 0], [0, 0, -1]).weight, 0, 'facing away');
  assert.ok(close(projectionUV(t, [0, 0.05, 0], [0, 0, 1]).uv[1], 1), 'up is up');
});

test('rotation, flip, slide and turn move the image as expected', () => {
  const base = placeProjection('img', 'flat', [0, 0, 0], [0, 0, 1], { positions: [], normals: [] }, 0.1);
  const right = [0.03, 0, 0];
  assert.ok(projectionUV(base, right, [0, 0, 1]).uv[0] > 0.5);
  assert.ok(projectionUV({ ...base, flip: true }, right, [0, 0, 1]).uv[0] < 0.5);
  // Rotated 90° counter-clockwise, the image's right side points up.
  assert.ok(projectionUV({ ...base, rotation: 90 }, [0, 0.03, 0], [0, 0, 1]).uv[0] > 0.75);
  assert.deepEqual(slideProjection(base, 0.1).map((x) => Math.round(x * 100) / 100), [0, 0.1, 0]);
  const wrap = { ...base, mapping: 'wrap', axis: [0, 1, 0], front: [0, 0, 1] };
  assert.deepEqual(turnProjection(wrap, 90).map((x) => Math.round(x * 100) / 100), [1, 0, 0]);
});

test('on a sideways limb the image top points towards the middle of the model', () => {
  const cyl = cylinder([0.8, 0.5, 0], [1, 0, 0], 0.04, 0.4);
  const n = [0, 0, 1];
  const hit = [0.8, 0.5, 0.04];
  const t = placeProjection('img', 'wrap', hit, n, cyl, 0.08, 1, [0, 1, 0], [0.5, 0.5, 0]);
  assert.ok(t.axis[0] < -0.99, `axis ${t.axis}`);
  const far = placeProjection('img', 'wrap', [0.2, 0.5, 0.04], n, cylinder([0.2, 0.5, 0], [1, 0, 0], 0.04, 0.4), 0.08, 1, [0, 1, 0], [0.5, 0.5, 0]);
  assert.ok(far.axis[0] > 0.99, 'and on the other side, the other way');
});
