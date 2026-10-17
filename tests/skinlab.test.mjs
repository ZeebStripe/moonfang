import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_EYE,
  DEFAULT_SKIN,
  EYE_PRESETS,
  GRIME_PRESETS,
  SKIN_PRESETS,
  buildEyeMaterial,
  buildGrimeMaterial,
  buildSkinMaterial,
  grimeCoat,
  skinTone,
} from '../src/data/skinlab.ts';
import { GEN_LABELS, GEN_TYPES, defaultGenerator } from '../src/engine/generators.ts';

const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const inRange = (c) => c.every((v) => v >= 0 && v <= 1);

test('skin tone gets darker as melanin rises', () => {
  let last = Infinity;
  for (let m = 0; m <= 1.0001; m += 0.1) {
    const l = luminance(skinTone(m));
    assert.ok(l < last, `luminance should fall at melanin ${m.toFixed(1)}`);
    last = l;
  }
});

test('skin tone stays a valid colour at every extreme', () => {
  for (const melanin of [-1, 0, 0.5, 1, 2]) {
    for (const undertone of [-3, -1, 0, 1, 3]) assert.ok(inRange(skinTone(melanin, undertone)), `${melanin}/${undertone}`);
  }
});

test('warm undertones are less blue than cool ones', () => {
  for (const melanin of [0.1, 0.5, 0.9]) assert.ok(skinTone(melanin, 1)[2] < skinTone(melanin, -1)[2]);
});

test('every skin preset builds a material with unique layer names and valid colours', () => {
  for (const preset of SKIN_PRESETS) {
    const sm = buildSkinMaterial(preset.params);
    const names = sm.layers.map((l) => l.name);
    assert.equal(new Set(names).size, names.length, preset.name);
    for (const layer of sm.layers) assert.ok(inRange(layer.values.color), `${preset.name}/${layer.name}`);
  }
});

test('freckles are skipped when the freckle amount is negligible', () => {
  assert.ok(buildSkinMaterial({ freckles: 0 }).layers.every((l) => l.name !== 'Freckles'));
  assert.ok(buildSkinMaterial({ freckles: 0.5 }).layers.some((l) => l.name === 'Freckles'));
});

test('pores are off by default and added only when toggled on', () => {
  assert.equal(DEFAULT_SKIN.poresOn, false);
  assert.ok(buildSkinMaterial().layers.every((l) => l.name !== 'Pores'));
  assert.ok(buildSkinMaterial({ poresOn: true }).layers.some((l) => l.name === 'Pores'));
});

test('pore layer only writes relief and roughness, never colour', () => {
  const pores = buildSkinMaterial({ poresOn: true }).layers.find((l) => l.name === 'Pores');
  assert.equal(pores.channels.color, false);
  assert.equal(pores.generator.type, 'pores');
  assert.ok(pores.values.height < 0.5, 'pores dent the surface');
});

test('oilier skin is shinier (lower roughness)', () => {
  const rough = (oiliness) => buildSkinMaterial({ oiliness }).layers[0].values.roughness;
  assert.ok(rough(1) < rough(0));
});

test('eye material stacks sclera, iris, limbal ring and pupil in order', () => {
  const names = buildEyeMaterial(DEFAULT_EYE).layers.map((l) => l.name);
  assert.ok(names.indexOf('Sclera') < names.indexOf('Iris'));
  assert.ok(names.indexOf('Iris') < names.indexOf('Limbal Ring'));
  assert.ok(names.indexOf('Limbal Ring') < names.indexOf('Pupil'));
});

test('eye parameters are clamped so the pupil always fits inside the iris', () => {
  const sm = buildEyeMaterial({ irisRadius: 0.2, pupilRadius: 0.5 });
  const iris = sm.layers.find((l) => l.name === 'Iris').generator.amount;
  const pupil = sm.layers.find((l) => l.name === 'Pupil').generator.amount;
  assert.ok(pupil < iris);
  const huge = buildEyeMaterial({ irisRadius: 9 }).layers.find((l) => l.name === 'Iris').generator.amount;
  assert.ok(huge <= 0.45);
});

test('veins are skipped when the eyes are not bloodshot', () => {
  assert.ok(buildEyeMaterial({ veins: 0 }).layers.every((l) => l.name !== 'Veins'));
});

test('eye presets all build', () => {
  for (const p of EYE_PRESETS) assert.ok(buildEyeMaterial({ iris: p.iris }).layers.length >= 6, p.name);
});

test('generators used by Skin Lab exist, are labelled and have defaults', () => {
  const used = new Set([...buildSkinMaterial().layers, ...buildEyeMaterial().layers].flatMap((l) => (l.generator ? [l.generator.type] : [])));
  for (const type of used) {
    assert.ok(GEN_TYPES.includes(type), `${type} is a generator type`);
    assert.ok(GEN_LABELS[type], `${type} has a label`);
    assert.equal(defaultGenerator(type).type, type);
  }
});

test('shader generator ids never change for existing projects', () => {
  // The shader picks a generator by its index in GEN_TYPES, so new types must only be appended.
  assert.deepEqual(GEN_TYPES.slice(0, 9), ['none', 'edge', 'dirt', 'gradient', 'noise', 'facing', 'ao', 'curvature', 'hatch']);
});

test('eye layers default to sphere mapping looking down +Z, so they stay round whatever the UVs', () => {
  for (const layer of buildEyeMaterial().layers.filter((l) => l.generator)) {
    assert.equal(layer.generator.mapping, 'sphere', layer.name);
    assert.equal(layer.generator.axis, 2, layer.name);
  }
  for (const type of ['iris', 'pupil', 'limbal', 'eyeveins']) assert.equal(defaultGenerator(type).mapping, 'sphere');
  const uv = buildEyeMaterial({ mapping: 'uv' }).layers.find((l) => l.name === 'Iris');
  assert.equal(uv.generator.mapping, 'uv');
});

test('gaze moves every eye layer together; the pupil offset moves only the pupil, and stays inside the iris', () => {
  const eye = buildEyeMaterial({ gaze: [0.2, -0.1], pupilOffset: [0.05, 0] });
  for (const layer of eye.layers.filter((l) => l.generator && l.name !== 'Pupil')) assert.deepEqual(layer.generator.offset, [0.2, -0.1], layer.name);
  const pupil = (m) => m.layers.find((l) => l.name === 'Pupil').generator.offset;
  assert.ok(Math.abs(pupil(eye)[0] - 0.25) < 1e-9 && Math.abs(pupil(eye)[1] + 0.1) < 1e-9);
  // Iris 0.3, pupil 0.1: the pupil can move at most 0.2 from the iris centre.
  const far = pupil(buildEyeMaterial({ pupilOffset: [0.6, 0.8] }));
  assert.ok(Math.abs(Math.hypot(far[0], far[1]) - 0.2) < 1e-9);
  assert.deepEqual(pupil(buildEyeMaterial({ gaze: [3, -3] })), [0.5, -0.5], 'gaze is limited to 60°');
  assert.deepEqual(DEFAULT_EYE.gaze, [0, 0]);
});

test('grime coats stack over the skin in order, top coat last', () => {
  const grime = [grimeCoat('Dirt'), grimeCoat('Motor Oil')];
  grime[1].seed = 5;
  const names = buildSkinMaterial({ grime }).layers.map((l) => l.name);
  assert.equal(names.at(-2), 'Dirt');
  assert.equal(names.at(-1), 'Motor Oil');
  assert.ok(names.indexOf('Recess Shading') < names.indexOf('Dirt'), 'grime sits over the skin');
});

test('grime smoothness controls roughness: oil is glossy, dirt is matte', () => {
  const [dirt, oil] = buildGrimeMaterial([grimeCoat('Dirt'), grimeCoat('Motor Oil')]).layers;
  assert.ok(oil.values.roughness < 0.2 && dirt.values.roughness > 0.8);
  const custom = buildGrimeMaterial([{ ...grimeCoat('Dirt'), color: [0.1, 0.5, 0.2], smoothness: 1 }]).layers[0];
  assert.deepEqual(custom.values.color, [0.1, 0.5, 0.2]);
  assert.ok(custom.values.roughness < 0.06);
});

test('more grime covers more of the surface', () => {
  const at = (amount) => buildGrimeMaterial([{ ...grimeCoat('Dirt'), amount }]).layers[0];
  assert.ok(at(0.9).generator.amount > at(0.2).generator.amount);
  assert.ok(at(0.9).opacity >= at(0.2).opacity);
  assert.equal(buildGrimeMaterial([{ ...grimeCoat('Dirt'), amount: 0 }]).layers.length, 0, 'empty coats are skipped');
});

test('repeated coats get unique names and different seeds', () => {
  const stack = [];
  for (let i = 0; i < 3; i++) stack.push(grimeCoat('Dirt', stack));
  const layers = buildSkinMaterial({ grime: stack }).layers;
  const names = layers.map((l) => l.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes('Dirt 3'));
  assert.equal(new Set(stack.map((c) => c.seed)).size, 3);
});

test('every grime preset and pattern builds a valid layer', () => {
  for (const preset of GRIME_PRESETS) {
    for (const pattern of ['cavities', 'patches', 'splatter', 'top']) {
      const [layer] = buildGrimeMaterial([{ ...grimeCoat(preset.name), pattern }]).layers;
      assert.ok(inRange(layer.values.color), preset.name);
      assert.ok(GEN_TYPES.includes(layer.generator.type), `${preset.name}/${pattern}`);
      assert.equal(layer.channels.metallic, false);
    }
  }
});

test('the default skin has no grime and presets never share a grime list', () => {
  assert.deepEqual(DEFAULT_SKIN.grime, []);
  assert.ok(buildSkinMaterial().layers.every((l) => !GRIME_PRESETS.some((p) => p.name === l.name)));
});
