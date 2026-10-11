import * as THREE from 'three';
import { clearTarget, createRT, FullscreenPass, MeshPass, rawMaterial, UV_SPACE_VERT } from './gl';
import { BVH_FUNCS, projectionMaterial, rayAoMaterial, type HighPoly } from './highPoly';
import { applyCurvatureGain, DEFAULT_SHARP_ANGLE, meshEdges, setSharpAngle, type PaintMesh } from './meshLoader';

export interface BakeSettings {
  aoSamples: number;
  aoDistance: number;
  curvatureGain: number;
  /** high-poly projection cage: how far rays start outside / may end inside the low-poly surface (normalised units) */
  frontDistance: number;
  backDistance: number;
  /** faces meeting at more than this angle (degrees) form a sharp edge: it goes to the edge map, not the vertex curvature */
  sharpAngle: number;
  /** how far (normalised units) the sharp-edge signal reaches from the edge */
  edgeWidth: number;
}

export const DEFAULT_BAKE: BakeSettings = {
  aoSamples: 128,
  aoDistance: 0.6,
  curvatureGain: 1,
  frontDistance: 0.02,
  backDistance: 0.02,
  sharpAngle: DEFAULT_SHARP_ANGLE,
  edgeWidth: 0.02,
};

/**
 * Texture-space maps derived from the mesh:
 *  - coverage: 1 where a UV triangle covers the texel
 *  - seeds:    jump-flood result; for uncovered texels the UV of the nearest covered texel (used for padding/dilation)
 *  - maps (MRT, dilated):
 *      [0] meshA: rgb = position normalised to the bounding box (per axis), a = ambient occlusion
 *      [1] meshB: rgb = world normal * 0.5 + 0.5, a = curvature (0.5 flat, >0.5 convex)
 *      [2] meshC: rgb = UV tangent (dP/du) * 0.5 + 0.5, a = bitangent handedness (1 = right-handed)
 *      [3] meshD: rgb = baked high-poly normal in that tangent frame (flat without a high poly), a = 1 where projected
 * With a high poly, AO and curvature come from it wherever its projection hit.
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
     layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1; layout(location = 2) out vec4 o2;
     void main(){
       vec3 n = normalize(vNormal);
       o0 = vec4((vPos - uMin) / uSize, 1.0);
       o1 = vec4(n * 0.5 + 0.5, vCurv);
       // Rasterising in UV space, screen x/y are u/v: the derivatives are the per-triangle tangent frame,
       // the same one three.js derives when it renders normal maps without tangent attributes.
       vec3 dpdu = dFdx(vPos), dpdv = dFdy(vPos);
       vec3 t = normalize(dpdu - n * dot(n, dpdu));
       float hand = dot(cross(n, t), dpdv) < 0.0 ? 0.0 : 1.0;
       o2 = vec4(t * 0.5 + 0.5, hand);
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
     uniform sampler2D uRaw0; uniform sampler2D uRaw1; uniform sampler2D uRaw2; uniform sampler2D uAo; uniform sampler2D uCov; uniform sampler2D uSeeds;
     uniform bool uHigh; uniform sampler2D uProj0; uniform sampler2D uProj1; uniform sampler2D uProj2; uniform sampler2D uRayAo;
     uniform vec2 uTexel; uniform float uCurvK; uniform sampler2D uEdges;
     layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1; layout(location = 2) out vec4 o2; layout(location = 3) out vec4 o3;
     vec2 remap(vec2 uv){ if (texture(uCov, uv).r > 0.5) return uv; vec4 s = texture(uSeeds, uv); return s.x < 0.0 ? uv : s.xy; }
     // Normal of a neighbouring texel, or the centre one where the neighbour has no projection (one-sided difference).
     vec3 nAt(vec2 uv, vec3 c){ vec4 p = texture(uProj1, uv); return p.a > 0.5 && texture(uCov, uv).r > 0.5 ? p.xyz : c; }
     void main(){
       vec2 u = remap(vUv);
       vec4 a = texture(uAo, u);
       float ao = a.g > 1e-5 ? a.r / a.g : 1.0;
       vec4 r1 = texture(uRaw1, u);
       vec4 r2 = texture(uRaw2, u);
       float curv = r1.a;
       vec4 nd = vec4(0.5, 0.5, 1.0, 0.0);
       if (uHigh && texture(uProj0, u).g > 0.5) {
         vec4 p0 = texture(uProj0, u);
         vec3 hn = texture(uProj1, u).xyz;
         vec4 ra = texture(uRayAo, u);
         if (ra.g > 0.5) ao = ra.r / ra.g;
         nd = texture(uProj2, u);
         // Dominant normal curvature along u and v from high-poly normal differences (cf. computeCurvature).
         vec3 n0 = normalize(r1.xyz * 2.0 - 1.0);
         vec3 T = normalize(r2.xyz * 2.0 - 1.0);
         vec3 B = normalize(cross(n0, T)) * (r2.w > 0.5 ? 1.0 : -1.0);
         vec2 dx = vec2(uTexel.x, 0.0), dy = vec2(0.0, uTexel.y);
         float ku = dot(nAt(u + dx, hn) - nAt(u - dx, hn), T) / max(2.0 * p0.b, 1e-6);
         float kv = dot(nAt(u + dy, hn) - nAt(u - dy, hn), B) / max(2.0 * p0.a, 1e-6);
         float k = abs(ku) > abs(kv) ? ku : kv;
         curv = 0.5 + 0.5 * tanh(k * uCurvK);
       }
       // Sharp mesh edges (distance falloff, + convex / − concave) win where they are stronger.
       vec2 e = texture(uEdges, u).xy;
       float ce = 0.5 + 0.5 * (e.x - e.y);
       if (abs(ce - 0.5) > abs(curv - 0.5)) curv = ce;
       o0 = vec4(texture(uRaw0, u).xyz, ao);
       o1 = vec4(r1.xyz, curv);
       o2 = r2;
       o3 = nd;
     }`,
    {
      uRaw0: { value: null },
      uRaw1: { value: null },
      uRaw2: { value: null },
      uAo: { value: null },
      uCov: { value: null },
      uSeeds: { value: null },
      uHigh: { value: false },
      uProj0: { value: null },
      uProj1: { value: null },
      uProj2: { value: null },
      uRayAo: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uCurvK: { value: 0.1 },
      uEdges: { value: null },
    },
  );

  /** Distance from each texel to the nearest sharp convex (r) / concave (g) edge, as a 1 → 0 falloff over uWidth. */
  private edgeMat = rawMaterial(
    `${BVH_FUNCS}
     uniform BVH bvhConvex; uniform BVH bvhConcave; uniform float uWidth;
     in vec3 vPos;
     layout(location = 0) out vec4 o0;
     void main(){
       uvec4 fi; vec3 fn; vec3 bc; float side; vec3 op;
       float dv = bvhClosestPointToPoint(bvhConvex, vPos, uWidth, fi, fn, bc, side, op);
       float dc = bvhClosestPointToPoint(bvhConcave, vPos, uWidth, fi, fn, bc, side, op);
       o0 = vec4(clamp(1.0 - dv / uWidth, 0.0, 1.0), clamp(1.0 - dc / uWidth, 0.0, 1.0), 0.0, 1.0);
     }`,
    { bvhConvex: { value: null }, bvhConcave: { value: null }, uWidth: { value: 0.02 } },
    { vertex: UV_SPACE_VERT },
  );

  private projMat = projectionMaterial();
  private rayAoMat = rayAoMaterial();
  /** whether the last bake projected a high poly */
  usedHighPoly = false;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private fs: FullscreenPass,
  ) {}

  /**
   * @param uvGeometry the texture set's triangles (UV-space passes); the whole mesh still occludes for AO.
   * @param high       optional high-poly mesh: normal, AO and curvature are projected from it
   */
  async bake(
    mesh: PaintMesh,
    uvGeometry: THREE.BufferGeometry,
    size: number,
    settings: BakeSettings,
    onProgress?: (p: number, label: string) => void,
    high: HighPoly | null = null,
  ) {
    const r = this.renderer;
    this.dispose();
    this.size = size;
    setSharpAngle(mesh, settings.sharpAngle);
    applyCurvatureGain(mesh, settings.curvatureGain);
    const pass = new MeshPass(uvGeometry);
    const occluders = new MeshPass(mesh.geometry);

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
    const raw = createRT(size, size, { type: THREE.HalfFloatType, count: 3 });
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
      occluders.render(r, this.depthMat, shadow, cam);
      u.uDir.value.copy(dir);
      u.uLightView.value.copy(cam.matrixWorldInverse);
      u.uLightVP.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      pass.render(r, this.aoAccMat, aoAcc);
      if (i % 16 === 15) {
        onProgress?.((i / N) * (high ? 0.3 : 1), 'Ambient occlusion');
        await nextFrame();
      }
    }

    // 4b. High poly: project it along the low-poly normals, then ray-trace its AO.
    let proj: THREE.WebGLRenderTarget | null = null;
    let rayAo: THREE.WebGLRenderTarget | null = null;
    if (high) {
      onProgress?.(0.3, 'Projecting high poly');
      await nextFrame();
      proj = createRT(size, size, { type: THREE.HalfFloatType, count: 3 });
      clearTarget(r, proj, 0, 0, 0, 0);
      const pu = this.projMat.uniforms;
      pu.bvh.value = high.bvh;
      pu.uHighN.value = high.normals;
      pu.uFront.value = settings.frontDistance;
      pu.uBack.value = settings.backDistance;
      const strips = new StripScheduler(r);
      await strips.run(proj, size, () => pass.render(r, this.projMat, proj!));

      rayAo = createRT(size, size, { type: THREE.FloatType });
      clearTarget(r, rayAo, 0, 0, 0, 0);
      const au = this.rayAoMat.uniforms;
      au.bvh.value = high.bvh;
      au.uHighN.value = high.normals;
      au.uProj0.value = proj.textures[0];
      au.uProj1.value = proj.textures[1];
      au.uFront.value = settings.frontDistance;
      au.uMaxDist.value = settings.aoDistance;
      au.uSize.value.set(size, size);
      const passes = Math.ceil(N / 2);
      for (let i = 0; i < passes; i++) {
        au.uSeed.value = i * 2.618 + 0.5;
        await strips.run(rayAo, size, () => pass.render(r, this.rayAoMat, rayAo!));
        onProgress?.(0.3 + (0.7 * (i + 1)) / passes, 'High-poly ambient occlusion');
      }
    }
    this.usedHighPoly = !!high;

    // 4c. Sharp edges: distance to the nearest convex / concave edge, for crisp even-width edge masks on low poly.
    const edges = meshEdges(mesh, settings.sharpAngle);
    const edgeRT = createRT(size, size, { type: THREE.HalfFloatType });
    clearTarget(r, edgeRT, 0, 0, 0, 0);
    const eu = this.edgeMat.uniforms;
    eu.bvhConvex.value = edges.convex;
    eu.bvhConcave.value = edges.concave;
    eu.uWidth.value = Math.max(1e-4, settings.edgeWidth);
    if (edges.count) await new StripScheduler(r).run(edgeRT, size, () => pass.render(r, this.edgeMat, edgeRT));

    // 5. Combine + dilate into the final maps.
    const c = this.combineMat.uniforms;
    c.uEdges.value = edgeRT.texture;
    c.uHigh.value = !!high;
    c.uProj0.value = proj?.textures[0] ?? null;
    c.uProj1.value = proj?.textures[1] ?? null;
    c.uProj2.value = proj?.textures[2] ?? null;
    c.uRayAo.value = rayAo?.texture ?? null;
    c.uTexel.value.set(1 / size, 1 / size);
    c.uCurvK.value = 0.1 * settings.curvatureGain;
    c.uRaw0.value = raw.textures[0];
    c.uRaw1.value = raw.textures[1];
    c.uRaw2.value = raw.textures[2];
    c.uAo.value = aoAcc.texture;
    c.uCov.value = this.coverage.texture;
    c.uSeeds.value = this.seeds.texture;
    this.maps = createRT(size, size, { type: THREE.HalfFloatType, count: 4, linear: true });
    this.fs.render(r, this.combineMat, this.maps);
    proj?.dispose();
    rayAo?.dispose();
    edgeRT.dispose();
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
  get meshCTex(): THREE.Texture {
    return this.maps.textures[2];
  }
  get meshDTex(): THREE.Texture {
    return this.maps.textures[3];
  }

  /**
   * Replaces whatever a failed bake left behind with neutral maps (full coverage, flat normals, no AO), so
   * compositing and painting keep working until the next successful bake.
   */
  placeholder(size: number) {
    const r = this.renderer;
    this.dispose();
    this.size = size;
    this.coverage = createRT(size, size);
    clearTarget(r, this.coverage, 1, 1, 1, 1);
    this.seeds = createRT(size, size, { type: THREE.FloatType });
    clearTarget(r, this.seeds, 0, 0, 0, 0);
    this.maps = createRT(size, size, { type: THREE.HalfFloatType, count: 4, linear: true });
    clearTarget(r, this.maps, 0.5, 0.5, 0.5, 1);
    r.setRenderTarget(null);
  }

  dispose() {
    if (!this.size) return;
    this.coverage?.dispose();
    this.seeds?.dispose();
    this.maps?.dispose();
    this.size = 0;
  }
}

/**
 * Runs a ray-traced UV-space pass in horizontal strips, each sized for roughly 50 ms of GPU time: one full-texture
 * draw on a slow GPU can outlast the driver watchdog (Windows TDR, ~2 s), which resets the WebGL context.
 * Waiting on a fence after each strip also keeps the browser responsive.
 */
class StripScheduler {
  private rows = 8;
  constructor(private r: THREE.WebGLRenderer) {}

  async run(target: THREE.WebGLRenderTarget, size: number, draw: () => void) {
    for (let y = 0; y < size; ) {
      const h = Math.min(this.rows, size - y);
      target.scissor.set(0, y, size, h);
      target.scissorTest = true;
      const t0 = performance.now();
      draw();
      await gpuFinish(this.r);
      const dt = performance.now() - t0;
      y += h;
      if (dt < 20) this.rows = Math.min(size, this.rows * 2);
      else if (dt > 80) this.rows = Math.max(1, this.rows >> 1);
    }
    target.scissorTest = false;
    this.r.setRenderTarget(null);
  }
}

/**
 * Resolves once the GPU has finished all submitted work (polled, so the main thread is not blocked). In a hidden
 * window (minimised, or covered by other windows) the browser stops updating fence status, which would stall the
 * bake until the window is shown again, so a blocking finish is used there instead.
 */
async function gpuFinish(r: THREE.WebGLRenderer) {
  const gl = r.getContext() as WebGL2RenderingContext;
  if (document.hidden) {
    gl.finish();
    return;
  }
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!sync) return;
  gl.flush();
  while (gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED) {
    // Hidden mid-wait: finish synchronously rather than wait for a status update that won't come.
    if (document.hidden) {
      gl.finish();
      break;
    }
    await new Promise((res) => setTimeout(res, 2));
  }
  gl.deleteSync(sync);
}

/** Yields to the browser so progress can repaint. Timer-based: rAF would stall the bake in a hidden tab. */
export function nextFrame(): Promise<void> {
  return new Promise((res) => setTimeout(res, 0));
}
