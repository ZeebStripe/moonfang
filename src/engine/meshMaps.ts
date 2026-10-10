import * as THREE from 'three';
import { clearTarget, createRT, FullscreenPass, MeshPass, rawMaterial, UV_SPACE_VERT } from './gl';
import { applyCurvatureGain, type PaintMesh } from './meshLoader';

export interface BakeSettings {
  aoSamples: number;
  aoDistance: number;
  curvatureGain: number;
}

export const DEFAULT_BAKE: BakeSettings = { aoSamples: 128, aoDistance: 0.6, curvatureGain: 1 };

/**
 * Texture-space maps derived from the mesh:
 *  - coverage: 1 where a UV triangle covers the texel
 *  - seeds:    jump-flood result; for uncovered texels the UV of the nearest covered texel (used for padding/dilation)
 *  - maps (MRT, dilated):
 *      [0] meshA: rgb = position normalised to the bounding box (per axis), a = ambient occlusion
 *      [1] meshB: rgb = world normal * 0.5 + 0.5, a = curvature (0.5 flat, >0.5 convex)
 */
export class MeshMaps {
  size = 0;
  coverage!: THREE.WebGLRenderTarget;
  seeds!: THREE.WebGLRenderTarget;
  maps!: THREE.WebGLRenderTarget;
  /** bbox extent per axis divided by the largest extent (to rebuild isotropic positions from meshA). */
  extentRatio = new THREE.Vector3(1, 1, 1);
  /** bbox used for meshA's normalised positions: world = bboxMin + meshA.xyz * bboxSize */
  bboxMin = new THREE.Vector3();
  bboxSize = new THREE.Vector3(1, 1, 1);

  private coverageMat = rawMaterial(`layout(location = 0) out vec4 o0; void main(){ o0 = vec4(1.0); }`, {}, { vertex: UV_SPACE_VERT });

  private jfaInitMat = rawMaterial(
    `in vec2 vUv; uniform sampler2D uCov; layout(location = 0) out vec4 o0;
     void main(){ o0 = texture(uCov, vUv).r > 0.5 ? vec4(vUv, 0.0, 1.0) : vec4(-1.0); }`,
    { uCov: { value: null } },
  );

  private jfaStepMat = rawMaterial(
    `in vec2 vUv; uniform sampler2D uSrc; uniform float uStep; uniform vec2 uTexel;
     layout(location = 0) out vec4 o0;
     void main(){
       vec4 best = vec4(-1.0); float bd = 1e9;
       for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
         vec2 uv = vUv + vec2(float(x), float(y)) * uStep * uTexel;
         if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) continue;
         vec4 s = texture(uSrc, uv);
         if (s.x < 0.0) continue;
         vec2 d = s.xy - vUv; float dd = dot(d, d);
         if (dd < bd) { bd = dd; best = s; }
       }
       o0 = best;
     }`,
    { uSrc: { value: null }, uStep: { value: 1 }, uTexel: { value: new THREE.Vector2() } },
  );

  private rawMat = rawMaterial(
    `in vec3 vPos; in vec3 vNormal; in float vCurv;
     uniform vec3 uMin; uniform vec3 uSize;
     layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1;
     void main(){
       o0 = vec4((vPos - uMin) / uSize, 1.0);
       o1 = vec4(normalize(vNormal) * 0.5 + 0.5, vCurv);
     }`,
    { uMin: { value: new THREE.Vector3() }, uSize: { value: new THREE.Vector3() } },
    { vertex: UV_SPACE_VERT, defines: { USE_CURV: 1 } },
  );

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

  private aoAccMat = rawMaterial(
    `in vec3 vPos; in vec3 vNormal;
     uniform sampler2D uShadow; uniform mat4 uLightVP; uniform mat4 uLightView;
     uniform vec3 uDir; uniform float uBias; uniform float uMaxDist; uniform float uWeight;
     layout(location = 0) out vec4 o0;
     void main(){
       vec3 n = normalize(vNormal);
       float w = dot(n, uDir);
       if (w <= 0.0) { o0 = vec4(0.0); return; }
       vec3 p = vPos + n * uBias;
       vec4 lc = uLightVP * vec4(p, 1.0);
       vec2 suv = lc.xy / lc.w * 0.5 + 0.5;
       float d = -(uLightView * vec4(p, 1.0)).z;
       float sd = texture(uShadow, suv).r;
       float occ = d - sd;
       float vis = (occ <= uBias || occ > uMaxDist) ? 1.0 : 0.0;
       o0 = vec4(vis * w, w, 0.0, 0.0) * uWeight;
     }`,
    {
      uShadow: { value: null },
      uLightVP: { value: new THREE.Matrix4() },
      uLightView: { value: new THREE.Matrix4() },
      uDir: { value: new THREE.Vector3() },
      uBias: { value: 0.006 },
      uMaxDist: { value: 0.6 },
      uWeight: { value: 1 },
    },
    { vertex: UV_SPACE_VERT, blending: 'add' },
  );

  private combineMat = rawMaterial(
    `in vec2 vUv;
     uniform sampler2D uRaw0; uniform sampler2D uRaw1; uniform sampler2D uAo; uniform sampler2D uCov; uniform sampler2D uSeeds;
     layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1;
     vec2 remap(vec2 uv){ if (texture(uCov, uv).r > 0.5) return uv; vec4 s = texture(uSeeds, uv); return s.x < 0.0 ? uv : s.xy; }
     void main(){
       vec2 u = remap(vUv);
       vec4 a = texture(uAo, u);
       float ao = a.g > 1e-5 ? a.r / a.g : 1.0;
       o0 = vec4(texture(uRaw0, u).xyz, ao);
       o1 = texture(uRaw1, u);
     }`,
    { uRaw0: { value: null }, uRaw1: { value: null }, uAo: { value: null }, uCov: { value: null }, uSeeds: { value: null } },
  );

  constructor(
    private renderer: THREE.WebGLRenderer,
    private fs: FullscreenPass,
  ) {}

  async bake(mesh: PaintMesh, size: number, settings: BakeSettings, onProgress?: (p: number, label: string) => void) {
    const r = this.renderer;
    this.dispose();
    this.size = size;
    applyCurvatureGain(mesh, settings.curvatureGain);
    const pass = new MeshPass(mesh.geometry);

    this.coverage = createRT(size, size);
    this.seeds = createRT(size, size, { type: THREE.FloatType });

    // 1. Coverage
    onProgress?.(0, 'UV coverage');
    clearTarget(r, this.coverage, 0, 0, 0, 0);
    pass.render(r, this.coverageMat, this.coverage);

    // 2. Jump flood → nearest covered texel for every uncovered texel.
    const ping = this.seeds;
    const pong = createRT(size, size, { type: THREE.FloatType });
    this.jfaInitMat.uniforms.uCov.value = this.coverage.texture;
    this.fs.render(r, this.jfaInitMat, ping);
    let src = ping;
    let dst = pong;
    this.jfaStepMat.uniforms.uTexel.value.set(1 / size, 1 / size);
    const steps: number[] = [];
    for (let s = size / 2; s >= 1; s /= 2) steps.push(s);
    steps.push(1);
    for (const s of steps) {
      this.jfaStepMat.uniforms.uSrc.value = src.texture;
      this.jfaStepMat.uniforms.uStep.value = s;
      this.fs.render(r, this.jfaStepMat, dst);
      [src, dst] = [dst, src];
    }
    this.seeds = src;
    dst.dispose();

    // 3. Position / normal / curvature
    const bb = mesh.bbox;
    const ext = bb.getSize(new THREE.Vector3()).max(new THREE.Vector3(1e-4, 1e-4, 1e-4));
    const maxExt = Math.max(ext.x, ext.y, ext.z);
    this.extentRatio.set(ext.x / maxExt, ext.y / maxExt, ext.z / maxExt);
    this.bboxMin.copy(bb.min);
    this.bboxSize.copy(ext);
    const raw = createRT(size, size, { type: THREE.HalfFloatType, count: 2 });
    clearTarget(r, raw, 0.5, 0.5, 0.5, 1);
    this.rawMat.uniforms.uMin.value.copy(bb.min);
    this.rawMat.uniforms.uSize.value.copy(ext);
    pass.render(r, this.rawMat, raw);

    // 4. Ambient occlusion: visibility from many directions via orthographic depth maps.
    const shadowSize = 1024;
    const shadow = createRT(shadowSize, shadowSize, { type: THREE.FloatType, depth: true });
    const aoAcc = createRT(size, size, { type: THREE.HalfFloatType });
    clearTarget(r, aoAcc, 0, 0, 0, 0);
    const cam = new THREE.OrthographicCamera(-1.05, 1.05, 1.05, -1.05, 0.05, 10);
    const N = Math.max(8, settings.aoSamples | 0);
    const golden = Math.PI * (3 - Math.sqrt(5));
    const dir = new THREE.Vector3();
    const u = this.aoAccMat.uniforms;
    u.uShadow.value = shadow.texture;
    u.uWeight.value = 4 / N;
    u.uMaxDist.value = settings.aoDistance;
    for (let i = 0; i < N; i++) {
      const y = 1 - (2 * (i + 0.5)) / N;
      const rad = Math.sqrt(1 - y * y);
      const phi = i * golden;
      dir.set(Math.cos(phi) * rad, y, Math.sin(phi) * rad);
      cam.position.copy(dir).multiplyScalar(4);
      cam.up.set(0, 1, 0);
      if (Math.abs(dir.y) > 0.99) cam.up.set(1, 0, 0);
      cam.lookAt(0, 0, 0);
      cam.updateMatrixWorld();
      clearTarget(r, shadow, 1e4, 1e4, 1e4, 1);
      pass.render(r, this.depthMat, shadow, cam);
      u.uDir.value.copy(dir);
      u.uLightView.value.copy(cam.matrixWorldInverse);
      u.uLightVP.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      pass.render(r, this.aoAccMat, aoAcc);
      if (i % 16 === 15) {
        onProgress?.(i / N, 'Ambient occlusion');
        await nextFrame();
      }
    }

    // 5. Combine + dilate into the final maps.
    const c = this.combineMat.uniforms;
    c.uRaw0.value = raw.textures[0];
    c.uRaw1.value = raw.textures[1];
    c.uAo.value = aoAcc.texture;
    c.uCov.value = this.coverage.texture;
    c.uSeeds.value = this.seeds.texture;
    this.maps = createRT(size, size, { type: THREE.HalfFloatType, count: 2, linear: true });
    this.fs.render(r, this.combineMat, this.maps);
    raw.dispose();
    aoAcc.dispose();
    shadow.dispose();
    r.setRenderTarget(null);
    onProgress?.(1, 'Done');
  }

  get meshATex(): THREE.Texture {
    return this.maps.textures[0];
  }
  get meshBTex(): THREE.Texture {
    return this.maps.textures[1];
  }

  dispose() {
    if (!this.size) return;
    this.coverage?.dispose();
    this.seeds?.dispose();
    this.maps?.dispose();
    this.size = 0;
  }
}

/** Yields to the browser so progress can repaint. Timer-based: rAF would stall the bake in a hidden tab. */
export function nextFrame(): Promise<void> {
  return new Promise((res) => setTimeout(res, 0));
}
