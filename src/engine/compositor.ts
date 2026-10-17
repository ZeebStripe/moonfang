import * as THREE from 'three';
import { createRT, FullscreenPass, GLSL_MAPS, GLSL_NOISE, rawMaterial } from './gl';
import { mapUniforms, setMapUniforms, type TextureStore } from './library';
import { BLEND_MODES, GEN_TYPES, HEIGHT_BLENDS, type Layer } from './layers';
import { GLSL_REMAP, type MeshMaps } from './meshMaps';

/** GLSL for mask generators (edge wear, dirt, gradients, …) shared by the layer pass and the mask preview. */
const GLSL_MASK = /* glsl */ `
uniform int uMaskMode;          // 0 = no mask, 1 = painted mask, 2 = painted * generator
uniform sampler2D uMaskTex;
uniform int uGenType;
uniform vec4 uGen;              // amount, contrast, noiseScale, noiseAmount
uniform vec4 uGen2;             // invert, axis, seed, sphere mapping (eye generators)
uniform vec2 uGenOffset;        // eye generators: centre offset
uniform sampler2D uMeshA;       // posN.xyz, ao
uniform sampler2D uMeshB;       // worldNormal.xyz, curvature
uniform vec3 uExtentRatio;

// Cellular (Worley) noise: distance to the nearest of one jittered feature point per cell.
float worley(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  float d = 2.0;
  for (int z = -1; z <= 1; z++)
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) {
        vec3 g = vec3(float(x), float(y), float(z));
        vec3 o = vec3(hash31(i + g), hash31(i + g + 19.3), hash31(i + g + 47.1));
        d = min(d, length(g + o - f));
      }
  return d;
}

// Eye generators measure a radius r and a direction around the gaze axis. Sphere mapping (uGen2.w = 1) takes the
// angle between the surface normal and the look axis (uGen2.y: 0-2 = +X/+Y/+Z, 3-5 = -X/-Y/-Z). On a round eyeball
// the normal points away from its own centre, so the iris is a round cap on every eyeball in the set, wherever it
// sits and however its UVs are laid out (r = 0.5 at 60 degrees). UV mapping expects a texture laid out as a centred
// disc (the iris at the middle of the 0-1 square). uGenOffset moves the centre (x right, y up, seen looking at the
// eye): a rotation of the gaze with sphere mapping (0.5 = 60 degrees), a shift in UV units with UV mapping.
float eyeGenerator(vec2 uv, vec3 wn, float n) {
  float amount = uGen.x, contrast = uGen.y, nScale = uGen.z, nAmt = uGen.w;
  float r = 0.0;
  vec2 dir = vec2(1.0, 0.0);
  if (uGen2.w > 0.5) {
    // Look axis L with the screen right R and up U of a camera looking back at the eye along it.
    int ax = int(uGen2.y + 0.5);
    vec3 L = vec3(0.0, 0.0, 1.0), R = vec3(1.0, 0.0, 0.0), U = vec3(0.0, 1.0, 0.0);
    if (ax == 0) { L = vec3(1.0, 0.0, 0.0); R = vec3(0.0, 0.0, -1.0); }
    else if (ax == 1) { L = vec3(0.0, 1.0, 0.0); U = vec3(0.0, 0.0, -1.0); }
    else if (ax == 3) { L = vec3(-1.0, 0.0, 0.0); R = vec3(0.0, 0.0, 1.0); }
    else if (ax == 4) { L = vec3(0.0, -1.0, 0.0); U = vec3(0.0, 0.0, 1.0); }
    else if (ax == 5) { L = vec3(0.0, 0.0, -1.0); R = vec3(-1.0, 0.0, 0.0); }
    vec3 v = vec3(dot(wn, R), dot(wn, U), dot(wn, L));
    // Undo the gaze rotation (yaw towards R, then pitch towards U) so the moved centre lands on +z.
    vec2 a = uGenOffset * (3.14159265 / 1.5);
    v = vec3(v.x * cos(a.x) - v.z * sin(a.x), v.y, v.x * sin(a.x) + v.z * cos(a.x));
    v = vec3(v.x, v.y * cos(a.y) - v.z * sin(a.y), v.y * sin(a.y) + v.z * cos(a.y));
    float len = length(v);
    r = len > 1e-5 ? acos(clamp(v.z / len, -1.0, 1.0)) * (1.5 / 3.14159265) : 0.0;
    float lp = length(v.xy);
    dir = lp > 1e-5 ? v.xy / lp : vec2(1.0, 0.0);
  } else {
    vec2 q = uv - 0.5 - uGenOffset;
    r = length(q);
    dir = r > 1e-5 ? q / r : vec2(1.0, 0.0);
  }
  float soft = mix(0.06, 0.003, contrast);
  // Radial streaks: noise that varies with the angle (through the direction vector) but barely with the radius.
  float seed = uGen2.z * 13.17;
  float v = 0.0;
  if (uGenType == 12) {
    float fib = fbm(vec3(dir * nScale * 0.12, r * 14.0 + seed));
    float disc = 1.0 - smoothstep(amount - soft, amount, r + (n - 0.5) * 0.01);
    v = disc * mix(1.0, clamp(fib * 1.6 - 0.2, 0.0, 1.0), nAmt);
  } else if (uGenType == 13) {
    v = 1.0 - smoothstep(amount - soft, amount + soft, r);
  } else if (uGenType == 14) {
    float edge = amount + (n - 0.5) * nAmt * 0.03;
    v = smoothstep(edge * 0.82, edge, r) * (1.0 - smoothstep(edge, edge + soft, r));
  } else {
    float ridge = pow(1.0 - abs(2.0 * fbm(vec3(dir * nScale * 0.15, r * 6.0 + seed)) - 1.0), 7.0);
    float outside = smoothstep(0.28, 0.4, r) * (1.0 - smoothstep(0.6, 0.85, r));  // fade out past the eye's equator
    v = clamp(ridge * (0.3 + amount * 2.5) * outside * mix(1.0, n * 1.6, nAmt * 0.5), 0.0, 1.0);
  }
  return uGen2.x > 0.5 ? 1.0 - v : v;
}

float surfaceGenerator(vec3 posN, vec3 pos, vec3 wn, float curv, float ao, float n) {
  float amount = uGen.x, contrast = uGen.y, nScale = uGen.z, nAmt = uGen.w;
  float s = 0.0;
  if (uGenType == 1) s = clamp((curv - 0.5) * 2.0, 0.0, 1.0);
  else if (uGenType == 2) s = clamp((1.0 - ao) * 1.3 + clamp((0.5 - curv) * 2.5, 0.0, 1.0), 0.0, 1.0);
  else if (uGenType == 3) { int ax = int(uGen2.y + 0.5); s = ax == 0 ? posN.x : (ax == 1 ? posN.y : posN.z); }
  else if (uGenType == 4) s = n;
  else if (uGenType == 5) s = clamp(wn.y, 0.0, 1.0);
  else if (uGenType == 6) s = 1.0 - ao;
  else if (uGenType == 7) s = curv;
  else if (uGenType == 8) {
    // Comic-style hatching: diagonal ink lines (noise scale = line density) that thicken with shadow
    // (occlusion + cavities). The lines are slices of one diagonal plane family, so they stay parallel and seamless.
    float shade = clamp((1.0 - ao) * 1.6 + clamp((0.5 - curv) * 2.0, 0.0, 1.0), 0.0, 1.0);
    float stripe = abs(fract(dot(pos, vec3(0.62, 0.74, 0.26)) * nScale * 0.5) - 0.5) * 2.0;  // 0 on a line, 1 between
    // Shade only widens the lines (up to ~60% ink): even the darkest areas keep gaps, never a solid fill.
    s = shade * 0.6 + (0.5 - stripe) * 0.9;
    n = fbm(pos * 6.0 + uGen2.z * 13.17);  // breakup at a coarser scale than the line density
  }
  else if (uGenType == 9) s = pow(1.0 - worley(pos * nScale + uGen2.z * 7.31), 3.0) * mix(0.55, 1.0, smoothstep(0.25, 0.7, fbm(pos * 4.0 + uGen2.z * 3.7)));  // pores: small pits at cell centres, denser in some areas
  else if (uGenType == 10) s = (1.0 - worley(pos * nScale + uGen2.z * 7.31)) * smoothstep(0.3, 0.75, fbm(pos * 3.0 + uGen2.z * 5.1));  // freckles: speckles inside clusters
  // blush: soft blotches that favour clearly convex areas (cheeks, nose, knuckles). Mild convexity alone is not enough,
  // because on a body nearly everything is a little convex and the blush would cover all but the creases.
  else if (uGenType == 11) s = smoothstep(0.55, 0.85, curv) * 0.55 + n * 0.45;
  if (uGenType != 4) s += (n - 0.5) * nAmt;
  float t = 1.0 - amount;
  float w = mix(1.0, 0.02, contrast);
  float v = smoothstep(t - w * 0.5, t + w * 0.5, s);
  return uGen2.x > 0.5 ? 1.0 - v : v;
}

// No early return: ANGLE's HLSL translation warns about one (X4000, "potentially uninitialized").
float generator(vec2 uv, vec3 posN, vec3 pos, vec3 wn, float curv, float ao) {
  float n = fbm(pos * uGen.z + uGen2.z * 13.17);
  float v = 0.0;
  if (uGenType >= 12) v = eyeGenerator(uv, wn, n);
  else v = surfaceGenerator(posN, pos, wn, curv, ao, n);
  return v;
}

float computeMask(vec2 uv) {
  if (uMaskMode == 0) return 1.0;
  float m = texture(uMaskTex, uv).r;
  if (uMaskMode == 2) {
    vec4 a = texture(uMeshA, uv);
    vec4 b = texture(uMeshB, uv);
    m *= generator(uv, a.xyz, a.xyz * uExtentRatio, normalize(b.xyz * 2.0 - 1.0), b.w, a.w);
  }
  return m;
}
`;

const LAYER_FRAG = /* glsl */ `
in vec2 vUv;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
uniform sampler2D uAcc0;   // color.rgb (sRGB)
uniform sampler2D uAcc1;   // rough, metal, height
uniform sampler2D uAcc2;   // emissive.rgb (sRGB), opacity
uniform sampler2D uL0;
uniform sampler2D uL1;
uniform sampler2D uL2;
uniform sampler2D uL3;
uniform sampler2D uL4;
uniform vec3 uFillEmis;
uniform float uFillOpac;
uniform vec2 uFillEnable2; // emissive, opacity
uniform vec3 uFillColor;
uniform vec3 uFillVals;    // rough, metal, height
uniform vec4 uFillEnable;  // color, rough, metal, height
uniform float uFillNormal; // normal channel enabled
uniform vec3 uVariation;   // amount, scale, seed
uniform float uOpacity;
uniform int uBlend;
uniform int uHeightBlend;  // 0 = add, 1 = normal
uniform int uProjOn;        // fill layer projects a decal image (see decalProjection.ts, which mirrors this maths)
uniform sampler2D uProj;    // RGB ink colour (sRGB), A = coverage; top row first
uniform vec3 uProjC;        // centre
uniform vec3 uProjA;        // axis
uniform vec3 uProjF;        // front
uniform vec4 uProjP;        // radius, size, aspect, reach
uniform vec4 uProjP2;       // rotation (radians), flip, use image colour, wrap (1) / flat (0)
${GLSL_NOISE}
${GLSL_MASK}
${GLSL_MAPS}

// Wrap: the image is bent around the axis (x = arc length round from the front, y = height along the axis), on
// surfaces facing out from the axis within reach of the placed radius. Flat: projected along the axis.
vec4 projectionSample(vec3 p, vec3 n) {
  vec3 d = p - uProjC;
  float x, y, w;
  if (uProjP2.w > 0.5) {
    float h = dot(d, uProjA);
    vec3 q = d - uProjA * h;
    float dist = length(q);
    float ang = atan(dot(q, cross(uProjA, uProjF)), dot(q, uProjF));
    x = ang * dist;
    y = h;
    float outward = dist > 1e-6 ? dot(n, q / dist) : 0.0;
    w = smoothstep(0.0, 0.25, outward) * (1.0 - smoothstep(uProjP.w * 0.7, uProjP.w, abs(dist - uProjP.x)));
  } else {
    x = dot(d, cross(uProjF, uProjA));
    y = dot(d, uProjF);
    w = smoothstep(0.0, 0.25, dot(n, uProjA)) * (1.0 - smoothstep(uProjP.w * 0.7, uProjP.w, abs(dot(d, uProjA))));
  }
  float c = cos(uProjP2.x), s = sin(uProjP2.x);
  vec2 r = vec2(c * x + s * y, -s * x + c * y);
  vec2 uv = vec2((uProjP2.y > 0.5 ? -r.x : r.x) / (uProjP.y * uProjP.z), r.y / uProjP.y) + 0.5;
  if (w <= 0.0 || any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(0.0);
  // Level 0: the pass runs in UV space, where screen derivatives jump at every UV seam.
  vec4 t = textureLod(uProj, vec2(uv.x, 1.0 - uv.y), 0.0);
  // In one ink colour the decal's dark lines are the ink: light areas inside it (paper left between the lines,
  // which background removal only clears when it touches the border) stay skin.
  float ink = uProjP2.z > 0.5 ? 1.0 : 1.0 - dot(t.rgb, vec3(0.2126, 0.7152, 0.0722));
  return vec4(t.rgb, t.a * ink * w);
}

vec3 blendColor(vec3 a, vec3 b, int mode) {
  if (mode == 1) return a * b;
  if (mode == 2) return 1.0 - (1.0 - a) * (1.0 - b);
  if (mode == 3) return mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(0.5, a));
  if (mode == 4) return min(a + b, 1.0);
  if (mode == 5) return max(a - b, 0.0);
  return b;
}

void main() {
  vec4 a0 = texture(uAcc0, vUv);
  vec4 a1 = texture(uAcc1, vUv);
  vec4 a2 = texture(uAcc2, vUv);
  float m = computeMask(vUv) * uOpacity;

  vec3 col, em; float colA, r, rA, mt, mtA, h, hA, nA, emA, op, opA;
  vec2 nrm = vec2(0.0);
  // Paint and fill layers are separate programs: together they would need more than 16 samplers.
#ifdef PAINT_LAYER
  {
    vec4 l0 = texture(uL0, vUv), l1 = texture(uL1, vUv), l2 = texture(uL2, vUv), l3 = texture(uL3, vUv), l4 = texture(uL4, vUv);
    col = l0.rgb; colA = l0.a; r = l1.r; rA = l1.g; mt = l1.b; mtA = l1.a; h = l2.r; hA = l2.g;
    nrm = l3.xy * 2.0 - 1.0; nA = l3.z;
    em = l4.rgb; emA = l4.a; op = l2.b; opA = l2.a;
  }
#else
  {
    em = uFillEmis; emA = uFillEnable2.x; op = uFillOpac; opA = uFillEnable2.y;
    vec3 pos = texture(uMeshA, vUv).xyz * uExtentRatio;
    vec3 wn = normalize(texture(uMeshB, vUv).xyz * 2.0 - 1.0);
    col = uFillColor; r = uFillVals.x; mt = uFillVals.y; h = uFillVals.z;
    if (anyMap()) sampleMaps(pos, wn, col, r, mt, h);
    if (uMapNrm.x > 0.5) {
      vec3 T, B;
      tangentFrame(vUv, wn, T, B);
      nrm = sampleNormalMap(pos, wn, T, B);
    }
    nA = uFillNormal;
    float n = 0.0;
    if (uVariation.x > 0.0) n = (fbm(pos * uVariation.y + uVariation.z) - 0.5) * uVariation.x;
    col = clamp(col * (1.0 + n * 1.2), 0.0, 1.0);
    r = clamp(r + n * 0.7, 0.0, 1.0);
    h = clamp(h + n * 0.6, 0.0, 1.0);
    colA = uFillEnable.x; rA = uFillEnable.y; mtA = uFillEnable.z; hA = uFillEnable.w;
    if (uProjOn == 1) {
      vec4 t = projectionSample(pos, wn);
      if (uProjP2.z > 0.5) col = t.rgb;
      m *= t.a;
    }
  }
#endif

  vec3 outCol = mix(a0.rgb, blendColor(a0.rgb, col, uBlend), colA * m);
  float outR = mix(a1.r, r, rA * m);
  float outM = mix(a1.g, mt, mtA * m);
  float outH = uHeightBlend == 1 ? mix(a1.b, h, hA * m) : clamp(a1.b + (h - 0.5) * hA * m, 0.0, 1.0);
  // Normal detail (tangent xy): "add" combines with what is below (UDN-style), "normal" replaces it.
  vec2 below = vec2(a0.a, a1.a);
  vec2 outN = uHeightBlend == 1 ? mix(below, nrm, nA * m) : below + nrm * nA * m;
  o0 = vec4(outCol, outN.x);
  o1 = vec4(outR, outM, outH, outN.y);
  o2 = vec4(mix(a2.rgb, em, emA * m), mix(a2.a, op, opA * m));
}
`;

const MASK_PREVIEW_FRAG = /* glsl */ `
in vec2 vUv;
layout(location = 0) out vec4 o0;
${GLSL_NOISE}
${GLSL_MASK}
void main() { o0 = vec4(vec3(computeMask(vUv)), 1.0); }
`;

/** Folder: blends the folder's composited result over the stack below it through mask × opacity. */
const GROUP_FRAG = /* glsl */ `
in vec2 vUv;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
uniform sampler2D uBelow0;
uniform sampler2D uBelow1;
uniform sampler2D uBelow2;
uniform sampler2D uGroup0;
uniform sampler2D uGroup1;
uniform sampler2D uGroup2;
uniform float uOpacity;
${GLSL_NOISE}
${GLSL_MASK}
void main() {
  float m = computeMask(vUv) * uOpacity;
  o0 = mix(texture(uBelow0, vUv), texture(uGroup0, vUv), m);
  o1 = mix(texture(uBelow1, vUv), texture(uGroup1, vUv), m);
  o2 = mix(texture(uBelow2, vUv), texture(uGroup2, vUv), m);
}
`;

const DEFAULTS_FRAG = /* glsl */ `
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
// Alpha channels of 0/1 carry the accumulated normal detail (tangent xy, 0 = flat). 2: no emission, opaque.
void main() { o0 = vec4(0.5, 0.5, 0.5, 0.0); o1 = vec4(0.5, 0.0, 0.5, 0.0); o2 = vec4(0.0, 0.0, 0.0, 1.0); }
`;

/**
 * Final pass: sRGB→linear base color, ORM packing, height→normal, and UV padding. Padding next to a UV seam holds the
 * surface continued across the seam, so the height → normal differences and texture filtering stay continuous there.
 */
const FINAL_FRAG = /* glsl */ `
in vec2 vUv;
layout(location = 0) out vec4 o0;  // linear base color
layout(location = 1) out vec4 o1;  // ao, rough, metal, height
layout(location = 2) out vec4 o2;  // tangent-space normal (OpenGL)
layout(location = 3) out vec4 o3;  // linear emissive
uniform sampler2D uAcc0;
uniform sampler2D uAcc1;
uniform sampler2D uAcc2;
uniform sampler2D uMeshA;
uniform sampler2D uMeshD;   // baked high-poly normal (flat without one)
uniform sampler2D uCov;
uniform sampler2D uSeeds;
uniform sampler2D uTwin;
uniform vec2 uTwinXf;
uniform vec2 uTexel;
uniform float uNormalK;
uniform float uAoStrength;
${GLSL_NOISE}
${GLSL_REMAP}
float hAt(vec2 uv) { return texture(uAcc1, remap(uv)).b; }
void main() {
  vec2 u = remap(vUv);
  vec3 col = texture(uAcc0, u).rgb;
  vec4 a1 = texture(uAcc1, u);
  float ao = mix(1.0, texture(uMeshA, u).a, uAoStrength);
  float dx = (hAt(vUv + vec2(uTexel.x, 0.0)) - hAt(vUv - vec2(uTexel.x, 0.0))) * 0.5 / uTexel.x;
  float dy = (hAt(vUv + vec2(0.0, uTexel.y)) - hAt(vUv - vec2(0.0, uTexel.y))) * 0.5 / uTexel.y;
  vec3 nh = normalize(vec3(-dx * uNormalK, -dy * uNormalK, 1.0));
  // Detail normal from the normal channel, combined with the height normal (whiteout blend).
  vec2 dxy = vec2(texture(uAcc0, u).a, a1.a);
  float l2 = dot(dxy, dxy);
  if (l2 > 0.998) dxy *= sqrt(0.998 / l2);
  vec3 nd = vec3(dxy, sqrt(1.0 - dot(dxy, dxy)));
  vec3 n = normalize(vec3(nh.xy + nd.xy, nh.z * nd.z));
  // Painted detail sits on top of the baked high-poly normal (whiteout again).
  vec3 nb = normalize(texture(uMeshD, u).xyz * 2.0 - 1.0);
  n = normalize(vec3(nb.xy + n.xy, nb.z * n.z));
  vec4 a2 = texture(uAcc2, u);
  o0 = vec4(srgbToLinear(col), a2.a);  // alpha = opacity
  o3 = vec4(srgbToLinear(a2.rgb), 1.0);
  o1 = vec4(ao, a1.r, a1.g, a1.b);
  o2 = vec4(n * 0.5 + 0.5, 1.0);
}
`;

export interface CompositeSettings {
  normalStrength: number;
  aoStrength: number;
}

export class Compositor {
  size = 0;
  private pool: THREE.WebGLRenderTarget[] = [];
  /** MRT x4: baseColor (linear) + opacity, ORM+height, normal, emissive (linear). Used by the viewport and the exporter. */
  final!: THREE.WebGLRenderTarget;
  maskPreview!: THREE.WebGLRenderTarget;

  private defaultsMat = rawMaterial(DEFAULTS_FRAG, {});
  private groupMat = rawMaterial(GROUP_FRAG, {
    uBelow0: { value: null },
    uBelow1: { value: null },
    uBelow2: { value: null },
    uGroup0: { value: null },
    uGroup1: { value: null },
    uGroup2: { value: null },
    uOpacity: { value: 1 },
    ...maskUniforms(),
  });
  private layerUniforms: Record<string, THREE.IUniform> = {
    uAcc0: { value: null },
    uAcc1: { value: null },
    uAcc2: { value: null },
    uL0: { value: null },
    uL1: { value: null },
    uL2: { value: null },
    uL3: { value: null },
    uL4: { value: null },
    uFillEmis: { value: new THREE.Vector3() },
    uFillOpac: { value: 1 },
    uFillEnable2: { value: new THREE.Vector2() },
    uFillNormal: { value: 0 },
    uFillColor: { value: new THREE.Vector3() },
    uFillVals: { value: new THREE.Vector3() },
    uFillEnable: { value: new THREE.Vector4() },
    uVariation: { value: new THREE.Vector3() },
    uOpacity: { value: 1 },
    uBlend: { value: 0 },
    uHeightBlend: { value: 0 },
    uProjOn: { value: 0 },
    uProj: { value: null },
    uProjC: { value: new THREE.Vector3() },
    uProjA: { value: new THREE.Vector3(0, 1, 0) },
    uProjF: { value: new THREE.Vector3(0, 0, 1) },
    uProjP: { value: new THREE.Vector4(0, 1, 1, 1) },
    uProjP2: { value: new THREE.Vector4() },
    ...maskUniforms(),
    ...mapUniforms(),
  };
  private paintLayerMat = rawMaterial(LAYER_FRAG, this.layerUniforms, { defines: { PAINT_LAYER: 1 } });
  private fillLayerMat = rawMaterial(LAYER_FRAG, this.layerUniforms);
  private maskPreviewMat = rawMaterial(MASK_PREVIEW_FRAG, maskUniforms());
  private finalMat = rawMaterial(FINAL_FRAG, {
    uAcc0: { value: null },
    uAcc1: { value: null },
    uAcc2: { value: null },
    uMeshA: { value: null },
    uMeshD: { value: null },
    uCov: { value: null },
    uSeeds: { value: null },
    uTwin: { value: null },
    uTwinXf: { value: new THREE.Vector2(1, 0) },
    uTexel: { value: new THREE.Vector2() },
    uNormalK: { value: 0.02 },
    uAoStrength: { value: 1 },
  });
  private dummy = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  private clear = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);

  constructor(
    private renderer: THREE.WebGLRenderer,
    private fs: FullscreenPass,
  ) {
    this.dummy.needsUpdate = true;
    this.clear.needsUpdate = true;
  }

  resize(size: number) {
    if (size === this.size) return;
    this.dispose();
    this.size = size;
    this.final = createRT(size, size, { type: THREE.HalfFloatType, count: 4, linear: true, mipmaps: true });
    this.maskPreview = createRT(size, size, { linear: true });
  }

  composite(layers: Layer[], maps: MeshMaps, settings: CompositeSettings, store: TextureStore) {
    const r = this.renderer;
    const start = this.acquire();
    this.fs.render(r, this.defaultsMat, start);
    const result = this.compositeList(layers, start, true, maps, store);
    const f = this.finalMat.uniforms;
    f.uAcc0.value = result.textures[0];
    f.uAcc1.value = result.textures[1];
    f.uAcc2.value = result.textures[2];
    f.uMeshA.value = maps.meshATex;
    f.uMeshD.value = maps.meshDTex;
    f.uCov.value = maps.coverage.texture;
    f.uSeeds.value = maps.seeds.texture;
    f.uTwin.value = maps.twin.texture;
    f.uTwinXf.value.copy(maps.twinXf);
    f.uTexel.value.set(1 / this.size, 1 / this.size);
    f.uNormalK.value = 0.02 * settings.normalStrength;
    f.uAoStrength.value = settings.aoStrength;
    this.fs.render(r, this.finalMat, this.final);
    this.release(result);
    r.setRenderTarget(null);
  }

  /**
   * Composites `layers` on top of `src` and returns the target holding the result.
   * `owned` says whether this call may recycle `src` (a folder keeps the stack below it for its final mix).
   */
  private compositeList(layers: Layer[], src: THREE.WebGLRenderTarget, owned: boolean, maps: MeshMaps, store: TextureStore): THREE.WebGLRenderTarget {
    let cur = src;
    let curOwned = owned;
    for (const layer of layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      const dst = this.acquire();
      if (layer.kind === 'group') {
        const inner = this.compositeList(layer.children, cur, false, maps, store);
        const g = this.groupMat.uniforms;
        g.uBelow0.value = cur.textures[0];
        g.uBelow1.value = cur.textures[1];
        g.uBelow2.value = cur.textures[2];
        g.uGroup0.value = inner.textures[0];
        g.uGroup1.value = inner.textures[1];
        g.uGroup2.value = inner.textures[2];
        g.uOpacity.value = layer.opacity;
        this.setMaskUniforms(this.groupMat, layer, maps);
        this.fs.render(this.renderer, this.groupMat, dst);
        if (inner !== cur) this.release(inner);
      } else {
        this.renderLayer(layer, cur, dst, maps, store);
      }
      if (curOwned) this.release(cur);
      cur = dst;
      curOwned = true;
    }
    return cur;
  }

  private renderLayer(layer: Exclude<Layer, { kind: 'group' }>, src: THREE.WebGLRenderTarget, dst: THREE.WebGLRenderTarget, maps: MeshMaps, store: TextureStore) {
    const mat = layer.kind === 'paint' ? this.paintLayerMat : this.fillLayerMat;
    const u = this.layerUniforms;
    u.uAcc0.value = src.textures[0];
    u.uAcc1.value = src.textures[1];
    u.uAcc2.value = src.textures[2];
    u.uOpacity.value = layer.opacity;
    u.uBlend.value = BLEND_MODES.indexOf(layer.blend);
    u.uHeightBlend.value = HEIGHT_BLENDS.indexOf(layer.heightBlend);
    if (layer.kind === 'paint') {
      u.uL0.value = layer.rt.textures[0];
      u.uL1.value = layer.rt.textures[1];
      u.uL2.value = layer.rt.textures[2];
      u.uL3.value = layer.rt.textures[3];
      u.uL4.value = layer.rt.textures[4];
    } else {
      const v = layer.values;
      u.uFillColor.value.set(v.color[0], v.color[1], v.color[2]);
      u.uFillVals.value.set(v.roughness, v.metallic, v.height);
      const c = layer.channels;
      u.uFillEnable.value.set(+c.color, +c.roughness, +c.metallic, +c.height);
      u.uFillNormal.value = c.normal ? 1 : 0;
      u.uFillEmis.value.fromArray(v.emissive ?? [0, 0, 0]);
      u.uFillOpac.value = v.opacity ?? 1;
      u.uFillEnable2.value.set(c.emissive ? 1 : 0, c.opacity ? 1 : 0);
      u.uVariation.value.set(layer.variation, layer.variationScale, layer.seed);
      setMapUniforms(u, layer.maps, layer.tiling, store, this.size);
      u.uMeshC.value = maps.meshCTex;
      const t = layer.projection;
      const img = t ? store.get(t.image) : null;
      // A projected decal whose image hasn't loaded (or was deleted) shows nothing rather than a solid fill.
      u.uProjOn.value = t ? 1 : 0;
      u.uProj.value = img ?? this.clear;
      if (t) {
        u.uProjC.value.fromArray(t.center);
        u.uProjA.value.fromArray(t.axis);
        u.uProjF.value.fromArray(t.front);
        u.uProjP.value.set(t.radius, Math.max(t.size, 1e-4), Math.max(t.aspect, 1e-3), Math.max(t.reach, 1e-4));
        u.uProjP2.value.set(THREE.MathUtils.degToRad(t.rotation), t.flip ? 1 : 0, t.useImageColor ? 1 : 0, t.mapping === 'wrap' ? 1 : 0);
      }
    }
    this.setMaskUniforms(mat, layer, maps);
    this.fs.render(this.renderer, mat, dst);
  }

  /** Accumulation targets are pooled; nested folders need one extra live target per level. */
  private acquire(): THREE.WebGLRenderTarget {
    return this.pool.pop() ?? createRT(this.size, this.size, { type: THREE.HalfFloatType, count: 3 });
  }
  private release(rt: THREE.WebGLRenderTarget) {
    if (!this.pool.includes(rt)) this.pool.push(rt);
  }

  renderMaskPreview(layer: Layer | null, maps: MeshMaps) {
    if (!layer) return;
    this.setMaskUniforms(this.maskPreviewMat, layer, maps);
    this.fs.render(this.renderer, this.maskPreviewMat, this.maskPreview);
    this.renderer.setRenderTarget(null);
  }

  private setMaskUniforms(mat: THREE.RawShaderMaterial, layer: Layer, maps: MeshMaps) {
    const u = mat.uniforms;
    const mask = layer.mask;
    u.uMeshA.value = maps.meshATex;
    u.uMeshB.value = maps.meshBTex;
    u.uExtentRatio.value.copy(maps.extentRatio);
    if (!mask || !mask.enabled) {
      u.uMaskMode.value = 0;
      u.uMaskTex.value = this.dummy;
      return;
    }
    u.uMaskTex.value = mask.rt.texture;
    const g = mask.generator;
    if (!g || g.type === 'none') {
      u.uMaskMode.value = 1;
      return;
    }
    u.uMaskMode.value = 2;
    u.uGenType.value = GEN_TYPES.indexOf(g.type);
    u.uGen.value.set(g.amount, g.contrast, g.noiseScale, g.noiseAmount);
    u.uGen2.value.set(g.invert ? 1 : 0, g.axis, g.seed, g.mapping === 'sphere' ? 1 : 0);
    u.uGenOffset.value.set(g.offset?.[0] ?? 0, g.offset?.[1] ?? 0);
  }

  dispose() {
    if (!this.size) return;
    this.pool.forEach((rt) => rt.dispose());
    this.pool = [];
    this.final.dispose();
    this.maskPreview.dispose();
    this.size = 0;
  }
}

function maskUniforms(): Record<string, THREE.IUniform> {
  return {
    uMaskMode: { value: 0 },
    uMaskTex: { value: null },
    uGenType: { value: 0 },
    uGen: { value: new THREE.Vector4() },
    uGen2: { value: new THREE.Vector4() },
    uGenOffset: { value: new THREE.Vector2() },
    uMeshA: { value: null },
    uMeshB: { value: null },
    uExtentRatio: { value: new THREE.Vector3(1, 1, 1) },
  };
}
