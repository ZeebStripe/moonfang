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

/** Axis views (Blender's numpad 1 / 3 / 7, with Ctrl for the opposite side): where the camera sits, seen from the target. */
export const AXIS_VIEWS = {
  front: new THREE.Vector3(0, 0, 1),
  back: new THREE.Vector3(0, 0, -1),
  right: new THREE.Vector3(1, 0, 0),
  left: new THREE.Vector3(-1, 0, 0),
  top: new THREE.Vector3(0, 1, 0),
  bottom: new THREE.Vector3(0, -1, 0),
} as const;
export type AxisView = keyof typeof AXIS_VIEWS;

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
  /** orthographic twin of `camera` (numpad 5); the controls drive whichever one is in use */
  orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  ortho = false;
  /**
   * An environment background can't be drawn through an orthographic camera (it collapses to one colour), so in
   * orthographic views it is drawn first through this perspective camera, turned the same way.
   */
  private bgScene = new THREE.Scene();
  private bgCamera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  /** the named axis view the camera is in, or null once it is orbited away */
  axisView: AxisView | null = null;
  /** ortho was switched on by an axis view (Blender's auto perspective): orbiting away switches back */
  private autoOrtho = false;
  private viewListeners = new Set<() => void>();
  private orbitStart = new THREE.Quaternion();
  /** a mouse / touch interaction with the orbit controls is in progress */
  private interacting = false;
  private tweenId = 0;
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
    this.controls.minZoom = 0.05;
    this.controls.maxZoom = 40;
    // Orbiting by mouse leaves an axis view; with auto perspective it also leaves orthographic.
    this.controls.addEventListener('start', () => {
      this.interacting = true;
      this.orbitStart.copy(this.view3D.quaternion);
    });
    this.controls.addEventListener('end', () => (this.interacting = false));
    this.controls.addEventListener('change', () => {
      if (!this.interacting || this.axisView === null || this.tweenId) return;
      if (this.view3D.quaternion.angleTo(this.orbitStart) < 1e-4) return; // pan / zoom keep the view
      this.axisView = null;
      if (this.autoOrtho) this.setOrtho(false);
      else this.viewChanged();
    });

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
    return this.uvView ? this.uvCamera : this.view3D;
  }

  /** The 3D view's camera: perspective, or orthographic after numpad 5 / an axis view. */
  get view3D(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this.ortho ? this.orthoCamera : this.camera;
  }

  /** Called when the projection or the named view changes (for the view label). */
  onViewChange(fn: () => void) {
    this.viewListeners.add(fn);
  }
  private viewChanged() {
    for (const fn of this.viewListeners) fn();
  }

  /** Switches between perspective and orthographic, keeping what is on screen about the same size. */
  setOrtho(on: boolean, auto = false) {
    this.autoOrtho = on && auto;
    if (on === this.ortho) return this.viewChanged();
    const target = this.controls.target;
    const p = this.camera;
    const o = this.orthoCamera;
    if (on) {
      const dist = p.position.distanceTo(target);
      const halfH = dist * Math.tan(THREE.MathUtils.degToRad(p.fov / 2));
      Object.assign(o, { left: -halfH * p.aspect, right: halfH * p.aspect, top: halfH, bottom: -halfH, zoom: 1 });
      o.position.copy(p.position);
      o.quaternion.copy(p.quaternion);
      o.updateProjectionMatrix();
      this.controls.object = o;
    } else {
      // The orthographic zoom becomes a camera distance again.
      const offset = o.position.clone().sub(target);
      const dist = THREE.MathUtils.clamp(offset.length() / o.zoom, this.controls.minDistance, this.controls.maxDistance);
      p.position.copy(target).addScaledVector(offset.normalize(), dist);
      p.quaternion.copy(o.quaternion);
      this.controls.object = p;
    }
    this.ortho = on;
    this.controls.update();
    this.viewChanged();
  }

  /** Looks at the target from an axis (numpad 1 / 3 / 7), animated briefly, switching to orthographic like Blender. */
  viewFromAxis(view: AxisView) {
    const dir = AXIS_VIEWS[view].clone();
    // Straight up / down is a pole for the orbit controls: tilt a hair towards the front so "up" on screen is -Z.
    if (view === 'top' || view === 'bottom') dir.z = 1e-4;
    if (!this.ortho) this.setOrtho(true, true);
    this.axisView = view;
    this.tweenTo(dir.normalize());
    this.viewChanged();
  }

  /** Numpad 9: the opposite side of the current view. */
  viewOpposite() {
    const dir = this.view3D.position.clone().sub(this.controls.target).normalize().negate();
    const opposite: Partial<Record<AxisView, AxisView>> = { front: 'back', back: 'front', left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
    if (this.axisView) return this.viewFromAxis(opposite[this.axisView]!);
    this.tweenTo(dir);
  }

  /**
   * Numpad 4 / 6 / 8 / 2: turns the view by `deg` around the vertical axis (yaw) or the screen's horizontal axis
   * (pitch). Like Blender, it leaves an axis view (and its automatic orthographic).
   */
  orbitStep(axis: 'yaw' | 'pitch', deg: number) {
    const cam = this.view3D;
    const target = this.controls.target;
    const offset = cam.position.clone().sub(target);
    const rot = new THREE.Quaternion();
    if (axis === 'yaw') rot.setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(deg));
    else rot.setFromAxisAngle(new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion), THREE.MathUtils.degToRad(deg));
    offset.applyQuaternion(rot);
    // Stop short of the poles instead of flipping over them.
    const len = offset.length();
    if (Math.abs(offset.y / len) > 0.9995) return;
    this.axisView = null;
    if (this.autoOrtho) this.setOrtho(false);
    const view = this.view3D;
    const dist = view.position.distanceTo(target);
    view.position.copy(target).addScaledVector(offset.normalize(), dist);
    this.controls.update();
    this.viewChanged();
  }

  /** Ctrl + numpad: moves the view by a fraction of its height. */
  panStep(dx: number, dy: number) {
    const cam = this.view3D;
    const h = this.ortho
      ? (this.orthoCamera.top - this.orthoCamera.bottom) / this.orthoCamera.zoom
      : 2 * cam.position.distanceTo(this.controls.target) * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const move = new THREE.Vector3(dx, dy, 0).multiplyScalar(h * 0.1).applyQuaternion(cam.quaternion);
    cam.position.add(move);
    this.controls.target.add(move);
    this.controls.update();
  }

  /** Numpad + / −: zooms in (factor > 1) or out. */
  zoomStep(factor: number) {
    if (this.uvView) {
      this.uvCamera.zoom = THREE.MathUtils.clamp(this.uvCamera.zoom * factor, 0.1, 50);
      this.uvCamera.updateProjectionMatrix();
      return;
    }
    if (this.ortho) {
      this.orthoCamera.zoom = THREE.MathUtils.clamp(this.orthoCamera.zoom * factor, this.controls.minZoom, this.controls.maxZoom);
      this.orthoCamera.updateProjectionMatrix();
    } else {
      const t = this.controls.target;
      const offset = this.camera.position.clone().sub(t);
      const dist = THREE.MathUtils.clamp(offset.length() / factor, this.controls.minDistance, this.controls.maxDistance);
      this.camera.position.copy(t).addScaledVector(offset.normalize(), dist);
    }
    this.controls.update();
  }

  /** Swings the camera around the target to look from `dir` (unit vector), over a few frames. */
  private tweenTo(dir: THREE.Vector3) {
    const cam = this.view3D;
    const target = this.controls.target;
    const dist = cam.position.distanceTo(target);
    const from = cam.position.clone().sub(target).normalize();
    const turn = new THREE.Quaternion().setFromUnitVectors(from, dir);
    const start = performance.now();
    const id = ++this.tweenId;
    const step = () => {
      if (id !== this.tweenId) return;
      const t = Math.min(1, (performance.now() - start) / 180);
      const k = t * t * (3 - 2 * t);
      // Rotate the direction along the shortest arc (setFromUnitVectors also handles opposite directions).
      const d = from.clone().applyQuaternion(new THREE.Quaternion().slerp(turn, k));
      cam.position.copy(target).addScaledVector(d.normalize(), dist);
      this.controls.update();
      if (t < 1) requestAnimationFrame(step);
      else this.tweenId = 0;
    };
    // Without frames (hidden window) jump straight there.
    if (document.hidden) {
      cam.position.copy(target).addScaledVector(dir, dist);
      this.controls.update();
      this.tweenId = 0;
      return;
    }
    requestAnimationFrame(step);
  }

  /** Label for the view HUD, like Blender's ("Front Orthographic", "User Perspective"). */
  get viewLabel(): string {
    const name = this.axisView ? this.axisView[0].toUpperCase() + this.axisView.slice(1) : 'User';
    return `${name} ${this.ortho ? 'Orthographic' : 'Perspective'}`;
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
    this.tweenId = 0;
    if (this.ortho) this.setOrtho(false);
    this.axisView = null;
    this.camera.position.set(2.6, 1.6, 3.4).normalize().multiplyScalar(3.6);
    this.controls.target.set(0, 0, 0);
    this.camera.near = 0.01;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.viewChanged();
  }

  resize() {
    const parent = this.canvas.parentElement!;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Keep the orthographic view's height, adjust its width to the new aspect.
    const o = this.orthoCamera;
    const halfH = (o.top - o.bottom) / 2;
    o.left = -halfH * this.camera.aspect;
    o.right = halfH * this.camera.aspect;
    o.updateProjectionMatrix();
    this.updateUVFrustum();
  }

  render() {
    const r = this.renderer;
    r.setRenderTarget(null);
    r.clear(true, true, true);
    if (this.uvView) r.render(this.uvScene, this.uvCamera);
    else if (this.ortho && this.scene.background instanceof THREE.Texture) {
      const bg = this.scene.background;
      const b = this.bgScene;
      b.background = bg;
      b.backgroundBlurriness = this.scene.backgroundBlurriness;
      b.backgroundIntensity = this.scene.backgroundIntensity;
      b.backgroundRotation.copy(this.scene.backgroundRotation);
      this.bgCamera.fov = this.camera.fov;
      this.bgCamera.aspect = this.camera.aspect;
      this.bgCamera.updateProjectionMatrix();
      this.bgCamera.quaternion.copy(this.orthoCamera.quaternion);
      r.render(b, this.bgCamera);
      this.scene.background = null;
      r.render(this.scene, this.orthoCamera);
      this.scene.background = bg;
    } else r.render(this.scene, this.view3D);
  }
}
