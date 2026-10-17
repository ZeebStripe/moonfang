import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { autoSmoothCurvature, buildTopology, curvaturePercentile, followsShading, sharpEdges } from '../src/engine/meshAnalysis.ts';

/** Non-indexed geometry; smooth = keep the shared vertex normals, otherwise flat face normals. */
function mesh(g, smooth) {
  const n = g.toNonIndexed();
  if (!smooth) {
    n.deleteAttribute('normal');
    n.computeVertexNormals();
  }
  return buildTopology(n);
}

// A coarse sphere: neighbouring faces meet at 45–60°, like a low-poly game character's limbs.
const coarse = () => new THREE.SphereGeometry(1, 6, 4);

test('a coarse smooth-shaded mesh follows its shading: no sharp edges', () => {
  const topo = mesh(coarse(), true);
  assert.equal(followsShading(topo, 35), true);
  const e = sharpEdges(topo, 35);
  assert.equal(e.convex.length + e.concave.length, 0);
});

test('the same mesh flat-shaded keeps the angle rule', () => {
  const topo = mesh(coarse(), false);
  assert.equal(followsShading(topo, 35), false);
  assert.ok(sharpEdges(topo, 35).convex.length > 0);
});

test('a smooth-shaded mesh with few sharp edges keeps the angle rule (hard-surface rims)', () => {
  // A lathed cup: its base meets the side at 90°, shaded smooth across the rim (like the Vase demo).
  const profile = [new THREE.Vector2(0.01, -1), new THREE.Vector2(1, -1)];
  for (let i = 1; i <= 20; i++) profile.push(new THREE.Vector2(1, -1 + i / 10));
  const topo = mesh(new THREE.LatheGeometry(profile, 96), true);
  assert.equal(followsShading(topo, 35), false);
  assert.ok(sharpEdges(topo, 35).convex.length > 0, 'the rim stays a sharp edge');
});

test('curvature of a coarse smooth sphere goes to the vertices instead of the edge map', () => {
  const smooth = mesh(coarse(), true);
  const flat = mesh(coarse(), false);
  const p = (topo) => curvaturePercentile(topo, autoSmoothCurvature(topo, 35), 0.5);
  assert.ok(p(smooth) > 0.9, `smooth sphere is curved like a unit sphere (${p(smooth)})`);
  assert.ok(p(flat) < p(smooth) / 2, 'flat-shaded faces stay mostly flat (their sharp edges go to the edge map)');
});

test('curvaturePercentile is area weighted', () => {
  const topo = mesh(new THREE.SphereGeometry(1, 96, 64), true);
  const curv = new Float32Array(topo.n).fill(1);
  // Mark the corners of the first 1 % of triangles as highly curved: barely moves the 90th percentile.
  for (let i = 0; i < Math.floor(topo.n / 100); i++) curv[i] = 100;
  const p90 = curvaturePercentile(topo, curv, 0.9);
  assert.ok(Math.abs(p90 - 1) < 0.02, `p90 ${p90}`);
  assert.ok(curvaturePercentile(topo, curv, 0.9999) > 90);
});
