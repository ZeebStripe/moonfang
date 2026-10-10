import * as THREE from 'three';
import { clearTarget, Copier, createRT, FullscreenPass, GLSL_MAPS, MeshPass, rawMaterial, UV_SPACE_VERT } from './gl';
import { createMaskRT, createPaintRT, type ChannelSet, type Layer, type MaterialMaps, type MaterialValues } from './layers';
import { mapUniforms, setMapUniforms, type TextureStore } from './library';
import type { MeshMaps } from './meshMaps';

export interface BrushSettings {
  /** radius in CSS pixels */
  size: number;
  hardness: number;
  opacity: number;
  /** stamp spacing as a fraction of the radius */
  spacing: number;
  pressureSize: boolean;
  pressureOpacity: boolean;
  values: MaterialValues;
  channels: ChannelSet;
  /** texture maps of the brush material (triplanar) */
  maps: MaterialMaps | null;
  tiling: number;
  materialName: string;
  /** grey value used when painting into a mask */
  maskValue: number;
  /** mirror strokes across the model's center plane on this axis */
  symmetry: 'off' | 'x' | 'y' | 'z';
  /** brush tip id ('round' = procedural, uses hardness) */
  tip: string;
  /** degrees */
  angle: number;
  followStroke: boolean;
  sizeJitter: number;
  angleJitter: number;
  /** position jitter in brush radii */
  scatter: number;
  opacityJitter: number;
  /** lazy-mouse smoothing 0..0.95 */
  smoothing: number;
  stencil: StencilSettings;
}

/** Screen-space image that masks (or colors) the brush. Coordinates are CSS pixels in the viewport. */
export interface StencilSettings {
  imageId: string | null;
  enabled: boolean;
  x: number;
  y: number;
  width: number;
  /** degrees */
  rotation: number;
  tile: boolean;
  /** paint the stencil's colors (decal) instead of the brush color; its alpha masks the brush */
  useColor: boolean;
}

export const DEFAULT_STENCIL: StencilSettings = { imageId: null, enabled: false, x: 0, y: 0, width: 400, rotation: 0, tile: false, useColor: false };

/** Textures the painter needs for the current brush (resolved by the app). */
export interface BrushTextures {
  tip: THREE.Texture | null;
  stencil: THREE.Texture | null;
  /** device pixel ratio of the viewport (stencil coordinates are CSS pixels) */
  dpr: number;
}

export interface Stamp {
  /** drawing-buffer pixels, origin bottom-left */
  x: number;
  y: number;
  r: number;
  a: number;
  /** tip rotation in radians */
  rot?: number;
}

export type PaintPart = 'content' | 'mask';

interface UndoEntry {
  layer: Layer;
  part: PaintPart;
  rt: THREE.WebGLRenderTarget;
}

const MAX_STAMPS = 64;

/** Stencil lookup shared by the stamp pass (mask) and the apply pass (decal colors). */
const GLSL_STENCIL = /* glsl */ `
uniform int uStencilOn;
uniform int uStencilColor;
uniform int uStencilTile;
uniform sampler2D uStencil;
uniform vec4 uStencilXf;    // center x, center y, width, height (CSS px)
uniform float uStencilRot;  // radians
uniform vec2 uScreen;
uniform float uDpr;
vec2 cssFromBuffer(vec2 sp) { return vec2(sp.x, uScreen.y - sp.y) / uDpr; }
vec4 stencilSample(vec2 css) {
  vec2 d = css - uStencilXf.xy;
  float c = cos(uStencilRot), s = sin(uStencilRot);
  vec2 uv = vec2(c * d.x + s * d.y, -s * d.x + c * d.y) / uStencilXf.zw + 0.5;
  if (uStencilTile == 1) uv = fract(uv);
  else if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  return texture(uStencil, uv);
}
float stencilMask(vec4 t) { return uStencilColor == 1 ? t.a : dot(t.rgb, vec3(0.299, 0.587, 0.114)) * t.a; }
`;

function stencilUniforms(): Record<string, THREE.IUniform> {
  return {
    uStencilOn: { value: 0 },
    uStencilColor: { value: 0 },
    uStencilTile: { value: 0 },
    uStencil: { value: null },
    uStencilXf: { value: new THREE.Vector4(0, 0, 1, 1) },
    uStencilRot: { value: 0 },
    uScreen: { value: new THREE.Vector2(1, 1) },
    uDpr: { value: 1 },
  };
}

function setStencilUniforms(u: Record<string, THREE.IUniform>, st: StencilSettings, tex: BrushTextures, buf: THREE.Vector2) {
  const img = tex.stencil?.image as { width: number; height: number } | undefined;
  const on = st.enabled && !!tex.stencil && !!img;
  u.uStencilOn.value = on ? 1 : 0;
  u.uStencilColor.value = st.useColor ? 1 : 0;
  u.uStencilTile.value = st.tile ? 1 : 0;
  u.uStencil.value = tex.stencil;
  u.uStencilXf.value.set(st.x, st.y, st.width, img ? (st.width * img.height) / img.width : st.width);
  u.uStencilRot.value = THREE.MathUtils.degToRad(st.rotation);
  u.uScreen.value.copy(buf);
  u.uDpr.value = tex.dpr;
}
const UNDO_LIMIT = 24;

const STAMP_FRAG = /* glsl */ `
in vec3 vPos;
in vec3 vNormal;
layout(location = 0) out vec4 o0;
uniform mat4 uViewProj;
uniform mat4 uView;
uniform vec3 uCamPos;
uniform sampler2D uDepth;
uniform vec4 uStamps[${MAX_STAMPS}];
uniform float uStampRot[${MAX_STAMPS}];
uniform int uTipMode;        // 0 = procedural round, 1 = tip texture
uniform sampler2D uTip;
${GLSL_STENCIL}
uniform int uCount;
uniform float uHardness;
uniform float uOrtho;
uniform vec3 uMirror;       // per-axis scale: (1,1,1) = no mirror, (-1,1,1) = mirror X
uniform vec3 uMirrorCenter;
void main() {
  // For the symmetry pass, test the texel's mirror image against the brush instead of the texel itself.
  vec3 pos = uMirrorCenter + (vPos - uMirrorCenter) * uMirror;
  vec3 nrm = vNormal * uMirror;
  vec4 clip = uViewProj * vec4(pos, 1.0);
  if (clip.w <= 0.0) discard;
  vec2 ndc = clip.xy / clip.w;
  vec2 suv = ndc * 0.5 + 0.5;
  if (suv.x < 0.0 || suv.y < 0.0 || suv.x > 1.0 || suv.y > 1.0) discard;
  float d = -(uView * vec4(pos, 1.0)).z;
  float sceneD = texture(uDepth, suv).r;
  if (d > sceneD + 0.006 + d * 0.003) discard;
  vec3 V = uOrtho > 0.5 ? normalize((inverse(uView) * vec4(0.0, 0.0, 1.0, 0.0)).xyz) : normalize(uCamPos - pos);
  float facing = smoothstep(0.0, 0.25, dot(normalize(nrm), V));
  vec2 sp = suv * uScreen;
  float a = 0.0;
  for (int i = 0; i < ${MAX_STAMPS}; i++) {
    if (i >= uCount) break;
    vec4 s = uStamps[i];
    vec2 d = (sp - s.xy) / s.z;
    if (uTipMode == 0) {
      float dist = length(d);
      if (dist < 1.0) a = max(a, (1.0 - smoothstep(uHardness, 1.0, dist)) * s.w);
    } else {
      float c = cos(uStampRot[i]), sn = sin(uStampRot[i]);
      vec2 q = vec2(c * d.x + sn * d.y, -sn * d.x + c * d.y);
      // Tip images are stored top row first (v = 0 at the top); screen y points up.
      if (abs(q.x) < 1.0 && abs(q.y) < 1.0) a = max(a, texture(uTip, vec2(q.x * 0.5 + 0.5, 0.5 - q.y * 0.5)).r * s.w);
    }
  }
  if (uStencilOn == 1) a *= stencilMask(stencilSample(cssFromBuffer(sp)));
  if (a <= 0.0) discard;
  o0 = vec4(a * facing);
}
`;

const APPLY_PAINT_FRAG = /* glsl */ `
in vec2 vUv;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
uniform sampler2D uS0;
uniform sampler2D uS1;
uniform sampler2D uS2;
uniform sampler2D uStroke;
uniform float uOpacity;
uniform vec3 uColor;
uniform vec3 uVals;
uniform vec4 uEn;
uniform int uErase;
uniform sampler2D uMeshA;
uniform sampler2D uMeshB;
uniform vec3 uExtentRatio;
uniform vec3 uBBoxMin;
uniform vec3 uBBoxSize;
uniform mat4 uViewProj;
${GLSL_MAPS}
${GLSL_STENCIL}
vec2 chan(float v, float a, float bv, float k) {
  if (uErase == 1) return vec2(v, a * (1.0 - k));
  float na = a + (1.0 - a) * k;
  float nv = na > 1e-4 ? (v * a * (1.0 - k) + bv * k) / na : bv;
  return vec2(nv, na);
}
void main() {
  float m = texture(uStroke, vUv).r * uOpacity;
  vec4 s0 = texture(uS0, vUv), s1 = texture(uS1, vUv), s2 = texture(uS2, vUv);
  vec3 bc = uColor;
  vec3 bv = uVals;
  if (anyMap() && m > 0.0) {
    vec4 ma = texture(uMeshA, vUv);
    sampleMaps(ma.xyz * uExtentRatio, normalize(texture(uMeshB, vUv).xyz * 2.0 - 1.0), bc, bv.x, bv.y, bv.z);
  }
  if (uStencilOn == 1 && uStencilColor == 1 && m > 0.0) {
    // Decal: look up the stencil color at the screen position this texel projects to.
    vec3 world = uBBoxMin + texture(uMeshA, vUv).xyz * uBBoxSize;
    vec4 clip = uViewProj * vec4(world, 1.0);
    vec2 sp = (clip.xy / clip.w * 0.5 + 0.5) * uScreen;
    bc = stencilSample(cssFromBuffer(sp)).rgb;
  }
  float k = m * uEn.x;
  if (uErase == 1) {
    o0 = vec4(s0.rgb, s0.a * (1.0 - k));
  } else {
    float na = s0.a + (1.0 - s0.a) * k;
    vec3 c = na > 1e-4 ? (s0.rgb * s0.a * (1.0 - k) + bc * k) / na : bc;
    o0 = vec4(c, na);
  }
  o1 = vec4(chan(s1.r, s1.g, bv.x, m * uEn.y), chan(s1.b, s1.a, bv.y, m * uEn.z));
  o2 = vec4(chan(s2.r, s2.g, bv.z, m * uEn.w), 0.0, 1.0);
}
`;

const APPLY_MASK_FRAG = /* glsl */ `
in vec2 vUv;
layout(location = 0) out vec4 o0;
uniform sampler2D uS0;
uniform sampler2D uStroke;
uniform float uOpacity;
uniform float uValue;
void main() {
  float m = texture(uStroke, vUv).r * uOpacity;
  o0 = vec4(vec3(mix(texture(uS0, vUv).r, uValue, m)), 1.0);
}
`;

export class Painter {
  private depthRT: THREE.WebGLRenderTarget | null = null;
  private strokeRT: THREE.WebGLRenderTarget | null = null;
  private snapshot: THREE.WebGLRenderTarget | null = null;
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private size = 0;
  private active: { layer: Layer; part: PaintPart; erase: boolean; brush: BrushSettings } | null = null;
  private pass: MeshPass | null = null;
  private stampScratch = Array.from({ length: MAX_STAMPS }, () => new THREE.Vector4());

  private depthMat = (() => {
    const m = rawMaterial(
      `in float vD; layout(location = 0) out vec4 o0; void main(){ o0 = vec4(vD); }`,
      {},
      {
        vertex: `in vec3 position; uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix; out float vD;
                 void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vD = -mv.z; gl_Position = projectionMatrix * mv; }`,
      },
    );
    m.depthTest = true;
    m.depthWrite = true;
    return m;
  })();

  private stampMat = rawMaterial(
    STAMP_FRAG,
    {
      uViewProj: { value: new THREE.Matrix4() },
      uView: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uDepth: { value: null },
      uStamps: { value: this.stampScratch },
      uCount: { value: 0 },
      uHardness: { value: 0.5 },
      uOrtho: { value: 0 },
      uMirror: { value: new THREE.Vector3(1, 1, 1) },
      uStampRot: { value: new Array(MAX_STAMPS).fill(0) },
      uTipMode: { value: 0 },
      uTip: { value: null },
      ...stencilUniforms(),
      uMirrorCenter: { value: new THREE.Vector3() },
    },
    { vertex: UV_SPACE_VERT, blending: 'max' },
  );

  private applyPaintMat = rawMaterial(APPLY_PAINT_FRAG, {
    uS0: { value: null },
    uS1: { value: null },
    uS2: { value: null },
    uStroke: { value: null },
    uOpacity: { value: 1 },
    uColor: { value: new THREE.Vector3() },
    uVals: { value: new THREE.Vector3() },
    uEn: { value: new THREE.Vector4() },
    uErase: { value: 0 },
    uMeshA: { value: null },
    uMeshB: { value: null },
    uExtentRatio: { value: new THREE.Vector3(1, 1, 1) },
    uBBoxMin: { value: new THREE.Vector3() },
    uBBoxSize: { value: new THREE.Vector3(1, 1, 1) },
    uViewProj: { value: new THREE.Matrix4() },
    ...mapUniforms(),
    ...stencilUniforms(),
  });

  private maps: MeshMaps | null = null;
  private blank = (() => {
    const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    t.needsUpdate = true;
    return t;
  })();
  private store: TextureStore | null = null;

  /** Mesh maps + texture store used to sample textured brush materials. */
  setContext(maps: MeshMaps, store: TextureStore) {
    this.maps = maps;
    this.store = store;
  }

  private applyMaskMat = rawMaterial(APPLY_MASK_FRAG, {
    uS0: { value: null },
    uStroke: { value: null },
    uOpacity: { value: 1 },
    uValue: { value: 1 },
  });

  constructor(
    private renderer: THREE.WebGLRenderer,
    private fs: FullscreenPass,
    private copier: Copier,
  ) {}

  setMesh(geometry: THREE.BufferGeometry) {
    geometry.computeBoundingBox();
    geometry.boundingBox!.getCenter(this.stampMat.uniforms.uMirrorCenter.value);
    this.pass = new MeshPass(geometry);
  }

  setTextureSize(size: number) {
    if (size === this.size) return;
    this.size = size;
    this.strokeRT?.dispose();
    this.strokeRT = createRT(size, size);
    this.clearHistory();
  }

  get isPainting() {
    return !!this.active;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  beginStroke(layer: Layer, part: PaintPart, camera: THREE.Camera, brush: BrushSettings, erase: boolean, tex: BrushTextures): boolean {
    if (!this.pass || !this.strokeRT) return false;
    if (part === 'content' && layer.kind !== 'paint') return false;
    if (part === 'mask' && !layer.mask) return false;
    const r = this.renderer;
    const buf = r.getDrawingBufferSize(new THREE.Vector2());
    if (!this.depthRT || this.depthRT.width !== buf.x || this.depthRT.height !== buf.y) {
      this.depthRT?.dispose();
      this.depthRT = createRT(buf.x, buf.y, { type: THREE.FloatType, depth: true });
    }
    clearTarget(r, this.depthRT, 1e6, 1e6, 1e6, 1);
    this.pass.render(r, this.depthMat, this.depthRT, camera);

    const u = this.stampMat.uniforms;
    camera.updateMatrixWorld();
    u.uView.value.copy(camera.matrixWorldInverse);
    u.uViewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    u.uOrtho.value = (camera as THREE.OrthographicCamera).isOrthographicCamera ? 1 : 0;
    u.uDepth.value = this.depthRT.texture;
    u.uScreen.value.set(buf.x, buf.y);
    u.uHardness.value = Math.min(brush.hardness, 0.999);
    u.uTipMode.value = tex.tip ? 1 : 0;
    u.uTip.value = tex.tip ?? this.blank;
    const p = this.applyPaintMat.uniforms;
    p.uViewProj.value.copy(u.uViewProj.value);
    for (const mat of [this.stampMat, this.applyPaintMat]) setStencilUniforms(mat.uniforms, brush.stencil, tex, buf);

    this.begin(layer, part, brush, erase, 0);
    return true;
  }

  /** Applies the brush (or eraser) to the whole layer/mask in one undoable step, without projection. */
  fill(layer: Layer, part: PaintPart, brush: BrushSettings, erase: boolean): boolean {
    if (!this.strokeRT || this.active) return false;
    if (part === 'content' && layer.kind !== 'paint') return false;
    if (part === 'mask' && !layer.mask) return false;
    this.begin(layer, part, brush, erase, 1);
    this.applyPaintMat.uniforms.uStencilOn.value = 0;
    this.applyStroke();
    this.endStroke();
    return true;
  }

  private begin(layer: Layer, part: PaintPart, brush: BrushSettings, erase: boolean, strokeInit: number) {
    const r = this.renderer;
    clearTarget(r, this.strokeRT!, strokeInit, strokeInit, strokeInit, 1);
    const current = part === 'content' ? (layer as Extract<Layer, { kind: 'paint' }>).rt : layer.mask!.rt;
    this.snapshot = part === 'content' ? createPaintRT(this.size) : createMaskRT(r, this.size, 1);
    this.copier.copy(r, current.textures, this.snapshot);
    this.active = { layer, part, erase, brush };
    r.setRenderTarget(null);
  }

  addStamps(stamps: Stamp[]) {
    const a = this.active;
    if (!a || !this.pass || !this.strokeRT || !this.snapshot || !stamps.length) return;
    const r = this.renderer;
    const u = this.stampMat.uniforms;
    for (let i = 0; i < stamps.length; i += MAX_STAMPS) {
      const chunk = stamps.slice(i, i + MAX_STAMPS);
      chunk.forEach((s, j) => {
        this.stampScratch[j].set(s.x, s.y, Math.max(s.r, 0.5), s.a);
        (u.uStampRot.value as number[])[j] = s.rot ?? 0;
      });
      u.uCount.value = chunk.length;
      u.uMirror.value.set(1, 1, 1);
      this.pass.render(r, this.stampMat, this.strokeRT);
      const sym = this.active?.brush.symmetry;
      if (sym && sym !== 'off') {
        u.uMirror.value.set(sym === 'x' ? -1 : 1, sym === 'y' ? -1 : 1, sym === 'z' ? -1 : 1);
        this.pass.render(r, this.stampMat, this.strokeRT);
      }
    }
    this.applyStroke();
  }

  /** Re-derives the layer from the pre-stroke snapshot and the accumulated stroke mask. */
  private applyStroke() {
    const a = this.active;
    if (!a || !this.strokeRT || !this.snapshot) return;
    const r = this.renderer;
    const b = a.brush;
    if (a.part === 'content') {
      const layer = a.layer as Extract<Layer, { kind: 'paint' }>;
      const p = this.applyPaintMat.uniforms;
      p.uS0.value = this.snapshot.textures[0];
      p.uS1.value = this.snapshot.textures[1];
      p.uS2.value = this.snapshot.textures[2];
      p.uStroke.value = this.strokeRT.texture;
      p.uOpacity.value = b.opacity;
      p.uColor.value.set(...b.values.color);
      p.uVals.value.set(b.values.roughness, b.values.metallic, b.values.height);
      p.uEn.value.set(+b.channels.color, +b.channels.roughness, +b.channels.metallic, +b.channels.height);
      p.uErase.value = a.erase ? 1 : 0;
      if (this.maps && this.store) {
        p.uMeshA.value = this.maps.meshATex;
        p.uMeshB.value = this.maps.meshBTex;
        p.uExtentRatio.value.copy(this.maps.extentRatio);
        p.uBBoxMin.value.copy(this.maps.bboxMin);
        p.uBBoxSize.value.copy(this.maps.bboxSize);
        setMapUniforms(p, a.erase ? null : b.maps, b.tiling, this.store, this.size);
      }
      this.fs.render(r, this.applyPaintMat, layer.rt);
    } else {
      const p = this.applyMaskMat.uniforms;
      p.uS0.value = this.snapshot.texture;
      p.uStroke.value = this.strokeRT.texture;
      p.uOpacity.value = b.opacity;
      p.uValue.value = a.erase ? 0 : b.maskValue;
      this.fs.render(r, this.applyMaskMat, a.layer.mask!.rt);
    }
    r.setRenderTarget(null);
  }

  endStroke() {
    const a = this.active;
    if (!a || !this.snapshot) return;
    this.undoStack.push({ layer: a.layer, part: a.part, rt: this.snapshot });
    while (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift()!.rt.dispose();
    for (const e of this.redoStack) e.rt.dispose();
    this.redoStack = [];
    this.snapshot = null;
    this.active = null;
  }

  /** Swap the layer's texture with the stored one; returns the affected layer. */
  undo(): Layer | null {
    return this.swap(this.undoStack, this.redoStack);
  }
  redo(): Layer | null {
    return this.swap(this.redoStack, this.undoStack);
  }

  private swap(from: UndoEntry[], to: UndoEntry[]): Layer | null {
    const e = from.pop();
    if (!e) return null;
    const l = e.layer;
    if (e.part === 'content' && l.kind === 'paint') {
      const cur = l.rt;
      l.rt = e.rt;
      e.rt = cur;
    } else if (e.part === 'mask' && l.mask) {
      const cur = l.mask.rt;
      l.mask.rt = e.rt;
      e.rt = cur;
    } else {
      e.rt.dispose();
      return null;
    }
    to.push(e);
    return l;
  }

  /** Remove history that refers to a deleted layer (or a removed mask). */
  forgetLayer(layer: Layer, part?: PaintPart) {
    const keep = (e: UndoEntry) => {
      const drop = e.layer === layer && (!part || e.part === part);
      if (drop) e.rt.dispose();
      return !drop;
    };
    this.undoStack = this.undoStack.filter(keep);
    this.redoStack = this.redoStack.filter(keep);
  }

  clearHistory() {
    for (const e of [...this.undoStack, ...this.redoStack]) e.rt.dispose();
    this.undoStack = [];
    this.redoStack = [];
  }
}
