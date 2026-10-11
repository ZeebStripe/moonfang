import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export const VIEW_MODES = [
  ['material', 'Material'],
  ['baseColor', 'Base Color'],
  ['roughness', 'Roughness'],
  ['metallic', 'Metallic'],
  ['height', 'Height'],
  ['normal', 'Normal'],
  ['emissive', 'Emissive'],
  ['opacity', 'Opacity'],
  ['ao', 'Ambient Occlusion'],
  ['curvature', 'Curvature'],
  ['worldNormal', 'World Normal'],
  ['position', 'Position'],
  ['mask', 'Layer Mask'],
] as const;
export type ViewMode = (typeof VIEW_MODES)[number][0];

export interface ViewportTextures {
  baseColor: THREE.Texture;
  orm: THREE.Texture;
  normal: THREE.Texture;
  emissive: THREE.Texture;
  /** UV coverage of the set (1 inside islands) */
  coverage: THREE.Texture;
  meshA: THREE.Texture;
  meshB: THREE.Texture;
  mask: THREE.Texture;
}

const CHANNEL_VIEW_FRAG = /* glsl */ `
uniform sampler2D uTex;
uniform int uMode;
uniform sampler2D uCov;
uniform int uDim;      // 2D view: darken UV padding (texels outside the islands)
varying vec2 vUv;
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(max(c, 0.0), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
  vec4 t = texture2D(uTex, vUv);
  vec3 c;
  if (uMode == 0) c = toSrgb(t.rgb);       // linear color
  else if (uMode == 1) c = t.rgb;          // raw rgb
  else if (uMode == 2) c = vec3(t.r);
  else if (uMode == 3) c = vec3(t.g);
  else if (uMode == 4) c = vec3(t.b);
  else c = vec3(t.a);
  if (uDim == 1 && texture2D(uCov, vUv).r < 0.5) c *= 0.3;
  gl_FragColor = vec4(c, 1.0);
}
`;

export class Viewport {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  mesh: THREE.Mesh | null = null;
  pbrs: THREE.MeshPhysicalMaterial[] = [];
  channelMats: THREE.ShaderMaterial[] = [];
  mode: ViewMode = 'material';
  private textures: (ViewportTextures | null)[] = [];

  // 2D UV view: the active set's textures on the 0..1 square, with its UV wireframe on top.
  uvView = false;
  uvCamera = new THREE.OrthographicCamera(0, 1, 1, 0, -10, 10);
  uvControls: OrbitControls;
  private uvScene = new THREE.Scene();
  private uvPlane: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private uvWire: THREE.LineSegments | null = null;
  private uvSet = 0;
  private envTexture: THREE.Texture | null = null;
  private pmrem: THREE.PMREMGenerator;
  private _showBackground = true;
  private envRotation = 0;
  private bgColor = new THREE.Color(0x2a2b2f);

  constructor(public canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.autoClear = false;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('This browser/GPU does not support float render targets (EXT_color_buffer_float).');
    // Paint layers write five render targets at once.
    if (gl.getParameter(gl.MAX_DRAW_BUFFERS) < 5) throw new Error('This GPU supports fewer than 5 simultaneous render targets.');

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
    this.camera.position.set(2.6, 1.6, 3.4);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
    this.controls.zoomToCursor = true;
    this.controls.minDistance = 0.2;
    this.controls.maxDistance = 30;

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.setEnvironment(this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture);

    this.uvScene.background = new THREE.Color(0x1e1f22);
    const plane = new THREE.PlaneGeometry(1, 1);
    plane.translate(0.5, 0.5, 0);
    this.uvPlane = new THREE.Mesh(plane, this.makeChannelMat());
    this.uvScene.add(this.uvPlane);
    const border = new THREE.LineSegments(
      new THREE.EdgesGeometry(plane),
      new THREE.LineBasicMaterial({ color: 0x6b6f78, depthTest: false }),
    );
    border.renderOrder = 2;
    this.uvScene.add(border);
    this.uvCamera.position.set(0, 0, 5);
    this.uvControls = new OrbitControls(this.uvCamera, canvas);
    this.uvControls.enableRotate = false;
    this.uvControls.screenSpacePanning = true;
    this.uvControls.zoomToCursor = true;
    this.uvControls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.uvControls.enabled = false;

  }

  /** One material per texture set (the geometry's groups pick them). */
  setGeometry(geometry: THREE.BufferGeometry, setCount: number) {
    if (this.mesh) this.scene.remove(this.mesh);
    for (const m of [...this.pbrs, ...this.channelMats]) m.dispose();
    // Transparent so the opacity channel (base color alpha) shows; fully opaque texels render as before.
    this.pbrs = Array.from(
      { length: setCount },
      () => new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 1, metalness: 1, side: THREE.DoubleSide, transparent: true, emissive: 0xffffff }),
    );
    this.channelMats = Array.from({ length: setCount }, () => this.makeChannelMat());
    this.textures = new Array(setCount).fill(null);
    this.mesh = new THREE.Mesh(geometry, this.pbrs);
    this.scene.add(this.mesh);
    this.frame();
  }

  // Face selection (polygon fill tool): the selected faces tinted, the faces under the cursor highlighted.
  private faceOverlays = {
    sel: this.makeOverlay(0xff8a1f, 0.42),
    hover: this.makeOverlay(0xffffff, 0.28),
  };

  private makeOverlay(color: number, opacity: number) {
    const m = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }),
    );
    m.frustumCulled = false;
    m.renderOrder = 3;
    return m;
  }

  /** Shows faces in the current view (3D or UV); the geometry is owned by the viewport from now on. */
  setFaceOverlay(which: 'sel' | 'hover', geometry: THREE.BufferGeometry | null) {
    const m = this.faceOverlays[which];
    m.removeFromParent();
    m.geometry.dispose();
    m.geometry = geometry ?? new THREE.BufferGeometry();
    if (geometry) (this.uvView ? this.uvScene : this.scene).add(m);
  }

  setTextures(set: number, t: ViewportTextures) {
    this.textures[set] = t;
    const m = this.pbrs[set];
    if (!m) return;
    m.map = t.baseColor;
    m.roughnessMap = t.orm;
    m.metalnessMap = t.orm;
    m.aoMap = t.orm;
    m.normalMap = t.normal;
    m.emissiveMap = t.emissive;
    m.needsUpdate = true;
    this.applyMode();
    this.applyUVMode();
  }

  setMode(mode: ViewMode) {
    this.mode = mode;
    this.applyMode();
    this.applyUVMode();
  }

  private makeChannelMat() {
    return new THREE.ShaderMaterial({
      uniforms: { uTex: { value: null }, uMode: { value: 0 }, uCov: { value: null }, uDim: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: CHANNEL_VIEW_FRAG,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
  }

  private applyMode() {
    if (!this.mesh) return;
    if (this.mode === 'material') {
      this.mesh.material = this.pbrs;
      return;
    }
    this.textures.forEach((t, i) => {
      if (!t) return;
      const map: Record<Exclude<ViewMode, 'material'>, [THREE.Texture, number]> = {
        baseColor: [t.baseColor, 0],
        roughness: [t.orm, 3],
        metallic: [t.orm, 4],
        height: [t.orm, 5],
        normal: [t.normal, 1],
        emissive: [t.emissive, 0],
        opacity: [t.baseColor, 5],
        ao: [t.meshA, 5],
        curvature: [t.meshB, 5],
        worldNormal: [t.meshB, 1],
        position: [t.meshA, 1],
        mask: [t.mask, 2],
      };
      const [tex, mode] = map[this.mode as Exclude<ViewMode, 'material'>];
      this.channelMats[i].uniforms.uTex.value = tex;
      this.channelMats[i].uniforms.uMode.value = mode;
    });
    this.mesh.material = this.channelMats;
  }

  /** The camera that the user sees (and paints through). */
  get activeCamera(): THREE.Camera {
    return this.uvView ? this.uvCamera : this.camera;
  }

  setUVView(on: boolean) {
    this.uvView = on;
    this.controls.enabled = !on;
    this.uvControls.enabled = on;
    if (on) this.frameUV();
    this.applyUVMode();
  }

  /** Shows texture set `set` in the UV view, with a wireframe of `geometry`'s UVs (its draw range). */
  showUVSet(set: number, geometry: THREE.BufferGeometry) {
    this.uvSet = set;
    if (this.uvWire) {
      this.uvScene.remove(this.uvWire);
      this.uvWire.geometry.dispose();
    }
    const uv = geometry.attributes.uv as THREE.BufferAttribute;
    const start = geometry.drawRange.start;
    const count = Math.min(geometry.drawRange.count, uv.count - start);
    const tris = Math.floor(count / 3);
    const pos = new Float32Array(tris * 18);
    let o = 0;
    for (let t = 0; t < tris; t++) {
      for (let e = 0; e < 3; e++) {
        const a = start + t * 3 + e;
        const b = start + t * 3 + ((e + 1) % 3);
        pos[o++] = uv.getX(a);
        pos[o++] = uv.getY(a);
        pos[o++] = 0;
        pos[o++] = uv.getX(b);
        pos[o++] = uv.getY(b);
        pos[o++] = 0;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.uvWire = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthTest: false }));
    this.uvWire.renderOrder = 1;
    this.uvScene.add(this.uvWire);
    this.applyUVMode();
  }

  set showUVWire(v: boolean) {
    if (this.uvWire) this.uvWire.visible = v;
  }

  /** Fits the 0..1 UV square into the view. */
  frameUV() {
    this.uvCamera.zoom = 1;
    this.uvControls.target.set(0.5, 0.5, 0);
    this.uvCamera.position.set(0.5, 0.5, 5);
    this.updateUVFrustum();
    this.uvControls.update();
  }

  private updateUVFrustum() {
    const c = this.canvas;
    const aspect = (c.clientWidth || 1) / (c.clientHeight || 1);
    const half = 0.56;
    // Frustum around the camera position (OrbitControls pans by moving the camera).
    this.uvCamera.left = -half * Math.max(aspect, 1);
    this.uvCamera.right = half * Math.max(aspect, 1);
    this.uvCamera.top = half / Math.min(aspect, 1);
    this.uvCamera.bottom = -half / Math.min(aspect, 1);
    this.uvCamera.updateProjectionMatrix();
  }

  private applyUVMode() {
    const t = this.textures[this.uvSet];
    const u = this.uvPlane.material.uniforms;
    if (!t) return;
    u.uCov.value = t.coverage;
    u.uDim.value = 1;
    if (this.mode === 'material') {
      u.uTex.value = t.baseColor;
      u.uMode.value = 0;
    } else {
      // applyMode has already picked the channel for this set's 3D material.
      const ch = this.channelMats[this.uvSet];
      u.uTex.value = ch?.uniforms.uTex.value ?? t.baseColor;
      u.uMode.value = ch?.uniforms.uMode.value ?? 0;
    }
  }

  setEnvironment(tex: THREE.Texture) {
    this.envTexture?.dispose();
    this.envTexture = tex;
    this.scene.environment = tex;
    this.updateBackground();
  }

  async loadHDR(file: File) {
    const url = URL.createObjectURL(file);
    try {
      const { HDRLoader } = await import('three/examples/jsm/loaders/HDRLoader.js');
      const hdr = await new HDRLoader().loadAsync(url);
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      const env = this.pmrem.fromEquirectangular(hdr).texture;
      hdr.dispose();
      this.setEnvironment(env);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  set showBackground(v: boolean) {
    this._showBackground = v;
    this.updateBackground();
  }
  get showBackground() {
    return this._showBackground;
  }

  setEnvRotation(deg: number) {
    this.envRotation = deg;
    const rot = new THREE.Euler(0, THREE.MathUtils.degToRad(deg), 0);
    this.scene.environmentRotation.copy(rot);
    this.scene.backgroundRotation.copy(rot);
  }

  setExposure(v: number) {
    this.renderer.toneMappingExposure = v;
  }

  private updateBackground() {
    if (this._showBackground && this.envTexture) {
      this.scene.background = this.envTexture;
      this.scene.backgroundBlurriness = 0.55;
      this.scene.backgroundIntensity = 0.6;
    } else {
      this.scene.background = this.bgColor;
    }
    this.setEnvRotation(this.envRotation);
  }

  frame() {
    this.camera.position.set(2.6, 1.6, 3.4).normalize().multiplyScalar(3.6);
    this.controls.target.set(0, 0, 0);
    this.camera.near = 0.01;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  resize() {
    const parent = this.canvas.parentElement!;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.updateUVFrustum();
  }

  render() {
    const r = this.renderer;
    r.setRenderTarget(null);
    r.clear(true, true, true);
    if (this.uvView) r.render(this.uvScene, this.uvCamera);
    else r.render(this.scene, this.camera);
  }
}
