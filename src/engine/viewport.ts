import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

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
  meshA: THREE.Texture;
  meshB: THREE.Texture;
  mask: THREE.Texture;
}

const CHANNEL_VIEW_FRAG = /* glsl */ `
uniform sampler2D uTex;
uniform int uMode;
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
  }

  setMode(mode: ViewMode) {
    this.mode = mode;
    this.applyMode();
  }

  private makeChannelMat() {
    return new THREE.ShaderMaterial({
      uniforms: { uTex: { value: null }, uMode: { value: 0 } },
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

  setEnvironment(tex: THREE.Texture) {
    this.envTexture?.dispose();
    this.envTexture = tex;
    this.scene.environment = tex;
    this.updateBackground();
  }

  async loadHDR(file: File) {
    const url = URL.createObjectURL(file);
    try {
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
  }

  render() {
    const r = this.renderer;
    r.setRenderTarget(null);
    r.clear(true, true, true);
    r.render(this.scene, this.camera);
  }
}
