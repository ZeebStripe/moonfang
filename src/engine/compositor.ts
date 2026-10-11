import * as THREE from 'three';
import { createRT, FullscreenPass, GLSL_MAPS, GLSL_NOISE, rawMaterial } from './gl';
import { mapUniforms, setMapUniforms, type TextureStore } from './library';
import { BLEND_MODES, GEN_TYPES, HEIGHT_BLENDS, type Layer } from './layers';
import type { MeshMaps } from './meshMaps';

/** GLSL for mask generators (edge wear, dirt, gradients, …) shared by the layer pass and the mask preview. */
const GLSL_MASK = /* glsl */ `
uniform int uMaskMode;          // 0 = no mask, 1 = painted mask, 2 = painted * generator
uniform sampler2D uMaskTex;
uniform int uGenType;
uniform vec4 uGen;              // amount, contrast, noiseScale, noiseAmount
uniform vec4 uGen2;             // invert, axis, seed, -
uniform sampler2D uMeshA;       // posN.xyz, ao
uniform sampler2D uMeshB;       // worldNormal.xyz, curvature
uniform vec3 uExtentRatio;

float generator(vec3 posN, vec3 pos, vec3 wn, float curv, float ao) {
  float amount = uGen.x, contrast = uGen.y, nScale = uGen.z, nAmt = uGen.w;
  float n = fbm(pos * nScale + uGen2.z * 13.17);
  float s = 0.0;
  if (uGenType == 1) s = clamp((curv - 0.5) * 2.0, 0.0, 1.0);
  else if (uGenType == 2) s = clamp((1.0 - ao) * 1.3 + clamp((0.5 - curv) * 2.5, 0.0, 1.0), 0.0, 1.0);
  else if (uGenType == 3) { int ax = int(uGen2.y + 0.5); s = ax == 0 ? posN.x : (ax == 1 ? posN.y : posN.z); }
  else if (uGenType == 4) s = n;
  else if (uGenType == 5) s = clamp(wn.y, 0.0, 1.0);
  else if (uGenType == 6) s = 1.0 - ao;
  else if (uGenType == 7) s = curv;
  if (uGenType != 4) s += (n - 0.5) * nAmt;
  float t = 1.0 - amount;
  float w = mix(1.0, 0.02, contrast);
  float v = smoothstep(t - w * 0.5, t + w * 0.5, s);
  return uGen2.x > 0.5 ? 1.0 - v : v;
}

float computeMask(vec2 uv) {
  if (uMaskMode == 0) return 1.0;
  float m = texture(uMaskTex, uv).r;
  if (uMaskMode == 2) {
    vec4 a = texture(uMeshA, uv);
    vec4 b = texture(uMeshB, uv);
    m *= generator(a.xyz, a.xyz * uExtentRatio, normalize(b.xyz * 2.0 - 1.0), b.w, a.w);
  }
  return m;
}
`;

const LAYER_FRAG = /* glsl */ `
in vec2 vUv;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
uniform sampler2D uAcc0;   // color.rgb (sRGB)
uniform sampler2D uAcc1;   // rough, metal, height
uniform int uKind;         // 0 = paint, 1 = fill
uniform sampler2D uL0;
uniform sampler2D uL1;
uniform sampler2D uL2;
uniform sampler2D uL3;
uniform vec3 uFillColor;
uniform vec3 uFillVals;    // rough, metal, height
uniform vec4 uFillEnable;  // color, rough, metal, height
uniform float uFillNormal; // normal channel enabled
uniform vec3 uVariation;   // amount, scale, seed
uniform float uOpacity;
uniform int uBlend;
uniform int uHeightBlend;  // 0 = add, 1 = normal
${GLSL_NOISE}
${GLSL_MASK}
${GLSL_MAPS}

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
  float m = computeMask(vUv) * uOpacity;

  vec3 col; float colA, r, rA, mt, mtA, h, hA, nA;
  vec2 nrm = vec2(0.0);
  if (uKind == 0) {
    vec4 l0 = texture(uL0, vUv), l1 = texture(uL1, vUv), l2 = texture(uL2, vUv), l3 = texture(uL3, vUv);
    col = l0.rgb; colA = l0.a; r = l1.r; rA = l1.g; mt = l1.b; mtA = l1.a; h = l2.r; hA = l2.g;
    nrm = l3.xy * 2.0 - 1.0; nA = l3.z;
  } else {
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
  }

  vec3 outCol = mix(a0.rgb, blendColor(a0.rgb, col, uBlend), colA * m);
  float outR = mix(a1.r, r, rA * m);
  float outM = mix(a1.g, mt, mtA * m);
  float outH = uHeightBlend == 1 ? mix(a1.b, h, hA * m) : clamp(a1.b + (h - 0.5) * hA * m, 0.0, 1.0);
  // Normal detail (tangent xy): "add" combines with what is below (UDN-style), "normal" replaces it.
  vec2 below = vec2(a0.a, a1.a);
  vec2 outN = uHeightBlend == 1 ? mix(below, nrm, nA * m) : below + nrm * nA * m;
  o0 = vec4(outCol, outN.x);
  o1 = vec4(outR, outM, outH, outN.y);
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
uniform sampler2D uBelow0;
uniform sampler2D uBelow1;
uniform sampler2D uGroup0;
uniform sampler2D uGroup1;
uniform float uOpacity;
${GLSL_NOISE}
${GLSL_MASK}
void main() {
  float m = computeMask(vUv) * uOpacity;
  o0 = mix(texture(uBelow0, vUv), texture(uGroup0, vUv), m);
  o1 = mix(texture(uBelow1, vUv), texture(uGroup1, vUv), m);
}
`;

const DEFAULTS_FRAG = /* glsl */ `
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
// Alpha channels carry the accumulated normal detail (tangent xy, 0 = flat).
void main() { o0 = vec4(0.5, 0.5, 0.5, 0.0); o1 = vec4(0.5, 0.0, 0.5, 0.0); }
`;

/** Final pass: sRGB→linear base color, ORM packing, height→normal, and UV padding through the jump-flood seeds. */
const FINAL_FRAG = /* glsl */ `
in vec2 vUv;
layout(location = 0) out vec4 o0;  // linear base color
layout(location = 1) out vec4 o1;  // ao, rough, metal, height
layout(location = 2) out vec4 o2;  // tangent-space normal (OpenGL)
uniform sampler2D uAcc0;
uniform sampler2D uAcc1;
uniform sampler2D uMeshA;
uniform sampler2D uMeshD;   // baked high-poly normal (flat without one)
uniform sampler2D uCov;
uniform sampler2D uSeeds;
uniform vec2 uTexel;
uniform float uNormalK;
uniform float uAoStrength;
${GLSL_NOISE}
vec2 remap(vec2 uv) {
  if (texture(uCov, uv).r > 0.5) return uv;
  vec4 s = texture(uSeeds, uv);
  return s.x < 0.0 ? uv : s.xy;
}
float hAt(vec2 uv) { return texture(uAcc1, remap(clamp(uv, 0.0, 1.0))).b; }
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
  o0 = vec4(srgbToLinear(col), 1.0);
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
  /** MRT x3: baseColor (linear), ORM+height, normal. Used directly by the viewport material and the exporter. */
  final!: THREE.WebGLRenderTarget;
  maskPreview!: THREE.WebGLRenderTarget;

  private defaultsMat = rawMaterial(DEFAULTS_FRAG, {});
  private groupMat = rawMaterial(GROUP_FRAG, {
    uBelow0: { value: null },
    uBelow1: { value: null },
    uGroup0: { value: null },
    uGroup1: { value: null },
    uOpacity: { value: 1 },
    ...maskUniforms(),
  });
  private layerMat = rawMaterial(LAYER_FRAG, {
    uAcc0: { value: null },
    uAcc1: { value: null },
    uKind: { value: 0 },
    uL0: { value: null },
    uL1: { value: null },
    uL2: { value: null },
    uL3: { value: null },
    uFillNormal: { value: 0 },
    uFillColor: { value: new THREE.Vector3() },
    uFillVals: { value: new THREE.Vector3() },
    uFillEnable: { value: new THREE.Vector4() },
    uVariation: { value: new THREE.Vector3() },
    uOpacity: { value: 1 },
    uBlend: { value: 0 },
    uHeightBlend: { value: 0 },
    ...maskUniforms(),
    ...mapUniforms(),
  });
  private maskPreviewMat = rawMaterial(MASK_PREVIEW_FRAG, maskUniforms());
  private finalMat = rawMaterial(FINAL_FRAG, {
    uAcc0: { value: null },
    uAcc1: { value: null },
    uMeshA: { value: null },
    uMeshD: { value: null },
    uCov: { value: null },
    uSeeds: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uNormalK: { value: 0.02 },
    uAoStrength: { value: 1 },
  });
  private dummy = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);

  constructor(
    private renderer: THREE.WebGLRenderer,
    private fs: FullscreenPass,
  ) {
    this.dummy.needsUpdate = true;
  }

  resize(size: number) {
    if (size === this.size) return;
    this.dispose();
    this.size = size;
    this.final = createRT(size, size, { type: THREE.HalfFloatType, count: 3, linear: true, mipmaps: true });
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
    f.uMeshA.value = maps.meshATex;
    f.uMeshD.value = maps.meshDTex;
    f.uCov.value = maps.coverage.texture;
    f.uSeeds.value = maps.seeds.texture;
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
        g.uGroup0.value = inner.textures[0];
        g.uGroup1.value = inner.textures[1];
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
    const u = this.layerMat.uniforms;
    u.uAcc0.value = src.textures[0];
    u.uAcc1.value = src.textures[1];
    u.uOpacity.value = layer.opacity;
    u.uBlend.value = BLEND_MODES.indexOf(layer.blend);
    u.uHeightBlend.value = HEIGHT_BLENDS.indexOf(layer.heightBlend);
    if (layer.kind === 'paint') {
      u.uKind.value = 0;
      u.uL0.value = layer.rt.textures[0];
      u.uL1.value = layer.rt.textures[1];
      u.uL2.value = layer.rt.textures[2];
      u.uL3.value = layer.rt.textures[3];
    } else {
      u.uKind.value = 1;
      u.uL0.value = u.uL1.value = u.uL2.value = u.uL3.value = this.dummy;
      const v = layer.values;
      u.uFillColor.value.set(v.color[0], v.color[1], v.color[2]);
      u.uFillVals.value.set(v.roughness, v.metallic, v.height);
      const c = layer.channels;
      u.uFillEnable.value.set(+c.color, +c.roughness, +c.metallic, +c.height);
      u.uFillNormal.value = c.normal ? 1 : 0;
      u.uVariation.value.set(layer.variation, layer.variationScale, layer.seed);
      setMapUniforms(u, layer.maps, layer.tiling, store, this.size);
      u.uMeshC.value = maps.meshCTex;
    }
    this.setMaskUniforms(this.layerMat, layer, maps);
    this.fs.render(this.renderer, this.layerMat, dst);
  }

  /** Accumulation targets are pooled; nested folders need one extra live target per level. */
  private acquire(): THREE.WebGLRenderTarget {
    return this.pool.pop() ?? createRT(this.size, this.size, { type: THREE.HalfFloatType, count: 2 });
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
    u.uGen2.value.set(g.invert ? 1 : 0, g.axis, g.seed, 0);
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
    uMeshA: { value: null },
    uMeshB: { value: null },
    uExtentRatio: { value: new THREE.Vector3(1, 1, 1) },
  };
}
