import * as THREE from 'three';
import type { SmartMaterial } from '../data/materials';
import { Compositor } from './compositor';
import type { FullscreenPass } from './gl';
import { disposeLayer, type Layer } from './layers';
import type { TextureStore } from './library';
import { loadDemoMesh } from './meshLoader';
import { DEFAULT_BAKE, MeshMaps } from './meshMaps';
import { sceneThumbnail } from './thumbnails';

const SIZE = 256;

export interface SmartPreviewDeps {
  renderer: THREE.WebGLRenderer;
  fs: FullscreenPass;
  store: TextureStore;
  environment: () => THREE.Texture | null;
  /** the smart material's layers, as the app would add them (textures sized `size`) */
  build: (sm: SmartMaterial, size: number) => Layer[];
  /** false while the app bakes, paints or is otherwise busy: previews wait */
  idle: () => boolean;
}

/**
 * Shelf previews of smart materials: each one is composited for real on a small rounded cube (its own baked mesh maps,
 * so edge wear, dirt and ink generators show) and rendered to an image. Rendered lazily, one per tick, and cached by
 * content, so an updated smart material gets a new preview.
 */
export class SmartPreviews {
  private cache = new Map<string, string>();
  private queued = new Map<string, SmartMaterial>();
  private listeners = new Set<() => void>();
  private stage: Promise<Stage | null> | null = null;
  private timer = 0;

  constructor(private deps: SmartPreviewDeps) {}

  onUpdate(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The preview image, or null while it is still being rendered (it is queued; onUpdate fires when ready). */
  get(sm: SmartMaterial): string | null {
    const key = this.key(sm);
    const url = this.cache.get(key);
    if (url) return url;
    this.queued.set(key, sm);
    this.schedule();
    return null;
  }

  private key(sm: SmartMaterial) {
    // Textured layers are rendered again once their images have loaded.
    const ready = sm.layers.every((l) => this.deps.store.ready(l.maps));
    return `${sm.id}|${ready}|${JSON.stringify(sm.layers)}`;
  }

  private schedule(delay = 30) {
    if (this.timer) return;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      void this.next();
    }, delay);
  }

  private async next() {
    if (!this.queued.size) return;
    if (!this.deps.idle()) return this.schedule(500);
    this.stage ??= this.setup();
    const stage = await this.stage;
    if (!stage) return;
    const [key, sm] = this.queued.entries().next().value!;
    this.queued.delete(key);
    try {
      this.cache.set(key, stage.render(sm));
      for (const fn of this.listeners) fn();
    } catch (e) {
      console.warn('Smart material preview failed', e);
    }
    if (this.queued.size) this.schedule();
  }

  private async setup(): Promise<Stage | null> {
    try {
      const { renderer, fs } = this.deps;
      const mesh = loadDemoMesh('roundedCube');
      const maps = new MeshMaps(renderer, fs);
      await maps.bake(mesh, mesh.geometry, SIZE, { ...DEFAULT_BAKE, aoSamples: 48 });
      return new Stage(this.deps, mesh.geometry, maps);
    } catch (e) {
      console.warn('Smart material previews unavailable', e);
      return null;
    }
  }
}

/** The preview cube with its baked maps, a compositor and a camera looking at a corner. */
class Stage {
  private compositor: Compositor;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  private material: THREE.MeshStandardMaterial;

  constructor(
    private deps: SmartPreviewDeps,
    geometry: THREE.BufferGeometry,
    private maps: MeshMaps,
  ) {
    this.compositor = new Compositor(deps.renderer, deps.fs);
    this.compositor.resize(SIZE);
    const f = this.compositor.final.textures;
    // The same channel layout the viewport uses: linear base color, ORM (+height), tangent normal, emissive.
    this.material = new THREE.MeshStandardMaterial({
      map: f[0],
      roughnessMap: f[1],
      metalnessMap: f[1],
      aoMap: f[1],
      normalMap: f[2],
      emissiveMap: f[3],
      emissive: 0xffffff,
      roughness: 1,
      metalness: 1,
    });
    this.scene.add(new THREE.Mesh(geometry, this.material));
    const light = new THREE.DirectionalLight(0xffffff, 0.8);
    light.position.set(-2, 3, 2);
    this.scene.add(light);
    this.camera.position.set(2.2, 1.7, 2.6).normalize().multiplyScalar(4.6);
    this.camera.lookAt(0, -0.05, 0);
  }

  render(sm: SmartMaterial): string {
    const layers = this.deps.build(sm, SIZE);
    try {
      this.compositor.composite(layers, this.maps, { normalStrength: 1, aoStrength: 1 }, this.deps.store);
      this.scene.environment = this.deps.environment();
      return sceneThumbnail(this.deps.renderer, this.scene, this.camera, 88);
    } finally {
      layers.forEach(disposeLayer);
    }
  }
}
