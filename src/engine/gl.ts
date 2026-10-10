import * as THREE from 'three';

/** Shared GPU helpers: render-target factories, raw GLSL3 materials and fullscreen/UV-space passes. */

export const GLSL_PRECISION = 'precision highp float;\nprecision highp int;\nprecision highp sampler2D;\n';

export const FULLSCREEN_VERT = /* glsl */ `
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/** Rasterises the mesh in UV space: each texel receives the interpolated world position / normal of the surface. */
export const UV_SPACE_VERT = /* glsl */ `
in vec3 position;
in vec3 normal;
in vec2 uv;
#ifdef USE_CURV
in float curv;
out float vCurv;
#endif
out vec3 vPos;
out vec3 vNormal;
out vec2 vUv;
void main() {
  vPos = position;
  vNormal = normal;
  vUv = uv;
#ifdef USE_CURV
  vCurv = curv;
#endif
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;

export interface RTOptions {
  type?: THREE.TextureDataType;
  count?: number;
  linear?: boolean;
  mipmaps?: boolean;
  depth?: boolean;
}

export function createRT(width: number, height: number, o: RTOptions = {}): THREE.WebGLRenderTarget {
  const filter = o.linear ? THREE.LinearFilter : THREE.NearestFilter;
  const rt = new THREE.WebGLRenderTarget(width, height, {
    type: o.type ?? THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    count: o.count ?? 1,
    minFilter: o.mipmaps ? THREE.LinearMipmapLinearFilter : filter,
    magFilter: filter,
    generateMipmaps: !!o.mipmaps,
    depthBuffer: !!o.depth,
    stencilBuffer: false,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
  });
  for (const t of rt.textures) {
    t.colorSpace = THREE.NoColorSpace;
    if (o.mipmaps) t.anisotropy = 8;
  }
  return rt;
}

export function rawMaterial(
  fragment: string,
  uniforms: Record<string, THREE.IUniform>,
  opts: { vertex?: string; defines?: Record<string, string | number>; blending?: 'max' | 'add' } = {},
): THREE.RawShaderMaterial {
  const defines = Object.entries(opts.defines ?? {})
    .map(([k, v]) => `#define ${k} ${v}\n`)
    .join('');
  const m = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: GLSL_PRECISION + defines + (opts.vertex ?? FULLSCREEN_VERT),
    fragmentShader: GLSL_PRECISION + defines + fragment,
    uniforms,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  if (opts.blending) {
    m.blending = THREE.CustomBlending;
    m.blendEquation = opts.blending === 'max' ? THREE.MaxEquation : THREE.AddEquation;
    m.blendSrc = THREE.OneFactor;
    m.blendDst = THREE.OneFactor;
    m.blendEquationAlpha = m.blendEquation;
    m.blendSrcAlpha = THREE.OneFactor;
    m.blendDstAlpha = THREE.OneFactor;
  } else {
    m.blending = THREE.NoBlending;
  }
  return m;
}

/** Draws a single quad covering the whole target. */
export class FullscreenPass {
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mesh: THREE.Mesh;

  constructor() {
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  render(renderer: THREE.WebGLRenderer, material: THREE.Material, target: THREE.WebGLRenderTarget | null) {
    this.mesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }
}

/** Draws the paint mesh with a UV-space vertex shader (or any custom material). */
export class MeshPass {
  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  mesh: THREE.Mesh;

  constructor(geometry: THREE.BufferGeometry) {
    this.mesh = new THREE.Mesh(geometry);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  render(renderer: THREE.WebGLRenderer, material: THREE.Material, target: THREE.WebGLRenderTarget | null, camera?: THREE.Camera) {
    this.mesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, camera ?? this.camera);
  }
}

const _clearColor = new THREE.Color();
export function clearTarget(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, r = 0, g = 0, b = 0, a = 0) {
  const prevAlpha = renderer.getClearAlpha();
  renderer.getClearColor(_clearColor);
  const prev = _clearColor.clone();
  renderer.setRenderTarget(target);
  renderer.setClearColor(new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace), a);
  renderer.clear(true, true, false);
  renderer.setClearColor(prev, prevAlpha);
}

/** Copies N attachments from one MRT (or single) target into another, optionally resampling. */
export class Copier {
  private mats = new Map<number, THREE.RawShaderMaterial>();
  constructor(private fs: FullscreenPass) {}

  private material(count: number) {
    let m = this.mats.get(count);
    if (!m) {
      let decl = '';
      let body = '';
      const uniforms: Record<string, THREE.IUniform> = {};
      for (let i = 0; i < count; i++) {
        decl += `uniform sampler2D uSrc${i};\nlayout(location = ${i}) out vec4 o${i};\n`;
        body += `o${i} = texture(uSrc${i}, vUv);\n`;
        uniforms[`uSrc${i}`] = { value: null };
      }
      m = rawMaterial(`in vec2 vUv;\n${decl}void main(){\n${body}}`, uniforms);
      this.mats.set(count, m);
    }
    return m;
  }

  copy(renderer: THREE.WebGLRenderer, src: THREE.Texture[], dst: THREE.WebGLRenderTarget) {
    const m = this.material(src.length);
    src.forEach((t, i) => (m.uniforms[`uSrc${i}`].value = t));
    this.fs.render(renderer, m, dst);
  }
}

/** Reads one attachment of an RGBA8 target into a tightly packed Uint8Array (bottom row first, GL order). */
export function readRGBA8(renderer: THREE.WebGLRenderer, rt: THREE.WebGLRenderTarget, index = 0): Uint8Array {
  const { width, height } = rt;
  const buf = new Uint8Array(width * height * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, width, height, buf, undefined, index);
  return buf;
}

/** Shared GLSL: hashing, value noise, fbm and color helpers. */
export const GLSL_NOISE = /* glsl */ `
float hash31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i), hash31(i + vec3(1, 0, 0)), f.x),
        mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), f.x),
        mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec3(17.1, 9.2, 3.7);
    a *= 0.5;
  }
  return s / 0.96875;
}
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
`;
