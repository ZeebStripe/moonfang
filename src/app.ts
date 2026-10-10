import * as THREE from 'three';
import { Compositor, type CompositeSettings } from './engine/compositor';
import { Exporter } from './engine/exporter';
import { Copier, createRT, FullscreenPass } from './engine/gl';
import {
  createFillLayer,
  createMaskRT,
  createPaintLayer,
  createPaintRT,
  defaultGenerator,
  disposeLayer,
  newLayerId,
  type GeneratorParams,
  type Layer,
  type MaterialValues,
} from './engine/layers';
import type { PaintMesh } from './engine/meshLoader';
import { DEFAULT_BAKE, MeshMaps, type BakeSettings } from './engine/meshMaps';
import { Painter, type BrushSettings, type PaintPart, type Stamp } from './engine/painter';
import { readProject, restoreLayers, saveProject } from './engine/project';
import { Viewport } from './engine/viewport';
import { loadMeshSource } from './engine/meshLoader';
import { materialById, type MaterialPreset, type SmartMaterial } from './data/materials';

export type Tool = 'paint' | 'erase';
export type ChangeKind = 'layers' | 'selection' | 'brush' | 'mesh' | 'view' | 'history' | 'settings' | 'tool';

export interface ProgressInfo {
  active: boolean;
  label: string;
  value: number;
}

const DEFAULT_VALUES: MaterialValues = { color: [0.5, 0.5, 0.5], roughness: 0.5, metallic: 0, height: 0.5 };

export class App {
  viewport: Viewport;
  renderer: THREE.WebGLRenderer;
  fs = new FullscreenPass();
  copier = new Copier(this.fs);
  maps: MeshMaps;
  compositor: Compositor;
  painter: Painter;
  exporter: Exporter;

  mesh: PaintMesh | null = null;
  layers: Layer[] = [];
  selectedId: number | null = null;
  part: PaintPart = 'content';
  tool: Tool = 'paint';
  texSize = 2048;
  bake: BakeSettings = { ...DEFAULT_BAKE };
  composite: CompositeSettings = { normalStrength: 1, aoStrength: 1 };
  brush: BrushSettings = {
    size: 36,
    hardness: 0.6,
    opacity: 1,
    spacing: 0.12,
    pressureSize: true,
    pressureOpacity: false,
    values: { color: [0.8, 0.8, 0.78], roughness: 0.45, metallic: 0, height: 0.5 },
    channels: { color: true, roughness: true, metallic: true, height: false },
    materialName: 'Custom',
    maskValue: 1,
  };
  progress: ProgressInfo = { active: false, label: '', value: 0 };

  private ready = false;
  private needsComposite = true;
  private pendingStamps: Stamp[] = [];
  private listeners = new Set<(k: ChangeKind) => void>();
  private progressListeners = new Set<(p: ProgressInfo) => void>();
  private toastListeners = new Set<(msg: string, kind: 'info' | 'warn' | 'error') => void>();

  constructor(canvas: HTMLCanvasElement) {
    this.viewport = new Viewport(canvas);
    this.renderer = this.viewport.renderer;
    this.maps = new MeshMaps(this.renderer, this.fs);
    this.compositor = new Compositor(this.renderer, this.fs);
    this.painter = new Painter(this.renderer, this.fs, this.copier);
    this.exporter = new Exporter(this.renderer, this.fs);
    this.compositor.resize(this.texSize);
    this.painter.setTextureSize(this.texSize);
    const loop = () => {
      this.tick();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------- events
  on(fn: (k: ChangeKind) => void) {
    this.listeners.add(fn);
  }
  onProgress(fn: (p: ProgressInfo) => void) {
    this.progressListeners.add(fn);
  }
  onToast(fn: (msg: string, kind: 'info' | 'warn' | 'error') => void) {
    this.toastListeners.add(fn);
  }
  emit(k: ChangeKind) {
    for (const fn of this.listeners) fn(k);
  }
  toast(msg: string, kind: 'info' | 'warn' | 'error' = 'info') {
    for (const fn of this.toastListeners) fn(msg, kind);
  }
  private setProgress(active: boolean, label = '', value = 0) {
    this.progress = { active, label, value };
    for (const fn of this.progressListeners) fn(this.progress);
  }

  /** Request a recomposite of the layer stack on the next frame. */
  invalidate() {
    this.needsComposite = true;
  }

  get busy() {
    return this.progress.active;
  }

  // ---------------------------------------------------------------- frame loop
  private tick() {
    if (this.ready) {
      if (this.pendingStamps.length) {
        this.painter.addStamps(this.pendingStamps);
        this.pendingStamps = [];
        this.needsComposite = true;
      }
      if (this.needsComposite) {
        this.compositor.composite(this.layers, this.maps, this.composite);
        if (this.viewport.mode === 'mask') this.compositor.renderMaskPreview(this.selected, this.maps);
        this.needsComposite = false;
      }
    }
    this.viewport.render();
  }

  // ---------------------------------------------------------------- mesh & baking
  async openMesh(mesh: PaintMesh, resetLayers = true) {
    this.ready = false;
    this.mesh = mesh;
    this.viewport.setGeometry(mesh.geometry);
    this.painter.setMesh(mesh.geometry);
    this.painter.clearHistory();
    if (resetLayers) {
      this.layers.forEach(disposeLayer);
      this.layers = [];
    }
    await this.rebake();
    if (resetLayers) {
      const base = createFillLayer('Base', DEFAULT_VALUES);
      base.channels.height = false;
      const paint = createPaintLayer(this.renderer, this.texSize, 'Layer 1');
      this.layers = [base, paint];
      this.selectedId = paint.id;
      this.part = 'content';
    }
    for (const w of mesh.warnings) this.toast(w, 'warn');
    this.emit('mesh');
    this.emit('layers');
    this.emit('selection');
  }

  async rebake() {
    if (!this.mesh) return;
    this.ready = false;
    this.setProgress(true, 'Baking mesh maps', 0);
    try {
      await this.maps.bake(this.mesh, this.texSize, this.bake, (v, label) => this.setProgress(true, `Baking: ${label}`, v));
    } finally {
      this.setProgress(false);
    }
    this.bindViewportTextures();
    this.ready = true;
    this.invalidate();
  }

  private bindViewportTextures() {
    const f = this.compositor.final;
    this.viewport.setTextures({
      baseColor: f.textures[0],
      orm: f.textures[1],
      normal: f.textures[2],
      meshA: this.maps.meshATex,
      meshB: this.maps.meshBTex,
      mask: this.compositor.maskPreview.texture,
    });
  }

  async setResolution(size: number) {
    if (size === this.texSize || !this.mesh) return;
    const r = this.renderer;
    for (const l of this.layers) {
      if (l.kind === 'paint') {
        const rt = createPaintRT(size);
        this.copier.copy(r, l.rt.textures, rt);
        l.rt.dispose();
        l.rt = rt;
      }
      if (l.mask) {
        const rt = createMaskRT(r, size, 1);
        this.copier.copy(r, [l.mask.rt.texture], rt);
        l.mask.rt.dispose();
        l.mask.rt = rt;
      }
    }
    r.setRenderTarget(null);
    this.texSize = size;
    this.compositor.resize(size);
    this.painter.setTextureSize(size);
    await this.rebake();
    this.emit('settings');
    this.emit('history');
  }

  // ---------------------------------------------------------------- selection
  get selected(): Layer | null {
    return this.layers.find((l) => l.id === this.selectedId) ?? null;
  }

  select(id: number, part: PaintPart = 'content') {
    const l = this.layers.find((x) => x.id === id);
    if (!l) return;
    this.selectedId = id;
    this.part = part === 'mask' && l.mask ? 'mask' : 'content';
    if (this.viewport.mode === 'mask') this.invalidate();
    this.emit('selection');
  }

  setTool(t: Tool) {
    this.tool = t;
    this.emit('tool');
  }

  // ---------------------------------------------------------------- layer operations
  private insertAboveSelected(...ls: Layer[]) {
    const idx = this.layers.findIndex((l) => l.id === this.selectedId);
    this.layers.splice(idx < 0 ? this.layers.length : idx + 1, 0, ...ls);
    this.selectedId = ls[ls.length - 1].id;
    this.part = 'content';
    this.invalidate();
    this.emit('layers');
    this.emit('selection');
  }

  private nextName(base: string) {
    let i = 1;
    const names = new Set(this.layers.map((l) => l.name));
    while (names.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  }

  addPaintLayer() {
    this.insertAboveSelected(createPaintLayer(this.renderer, this.texSize, this.nextName('Layer')));
  }

  addFillLayer(preset?: MaterialPreset) {
    const l = createFillLayer(preset ? preset.name : this.nextName('Fill'), preset?.values ?? DEFAULT_VALUES);
    if (preset?.variation) l.variation = preset.variation;
    this.insertAboveSelected(l);
  }

  addSmartMaterial(sm: SmartMaterial) {
    const created: Layer[] = sm.layers.map((spec) => {
      const preset = materialById(spec.material);
      const values: MaterialValues = { ...preset.values, ...spec.values };
      const l = createFillLayer(`${sm.name} · ${spec.name}`, values, spec.channels);
      l.variation = spec.variation ?? preset.variation ?? 0;
      if (spec.variationScale) l.variationScale = spec.variationScale;
      if (spec.opacity !== undefined) l.opacity = spec.opacity;
      if (spec.blend) l.blend = spec.blend;
      if (spec.heightBlend) l.heightBlend = spec.heightBlend;
      if (spec.generator) {
        l.mask = {
          rt: createMaskRT(this.renderer, this.texSize, 1),
          enabled: true,
          generator: { ...defaultGenerator(spec.generator.type), ...spec.generator },
        };
      }
      return l;
    });
    this.renderer.setRenderTarget(null);
    this.insertAboveSelected(...created);
    this.toast(`Added smart material "${sm.name}" (${created.length} layers)`);
  }

  deleteLayer(id: number) {
    const idx = this.layers.findIndex((l) => l.id === id);
    if (idx < 0) return;
    const [l] = this.layers.splice(idx, 1);
    this.painter.forgetLayer(l);
    disposeLayer(l);
    if (this.selectedId === id) {
      const next = this.layers[Math.min(idx, this.layers.length - 1)];
      this.selectedId = next?.id ?? null;
      this.part = 'content';
    }
    this.invalidate();
    this.emit('layers');
    this.emit('selection');
    this.emit('history');
  }

  duplicateLayer(id: number) {
    const src = this.layers.find((l) => l.id === id);
    if (!src) return;
    const r = this.renderer;
    let mask = null;
    if (src.mask) {
      const rt = createMaskRT(r, this.texSize, 1);
      this.copier.copy(r, [src.mask.rt.texture], rt);
      mask = { ...src.mask, rt, generator: src.mask.generator ? { ...src.mask.generator } : null };
    }
    let copy: Layer;
    if (src.kind === 'paint') {
      const rt = createPaintRT(this.texSize);
      this.copier.copy(r, src.rt.textures, rt);
      copy = { ...src, id: newLayerId(), name: `${src.name} copy`, rt, mask };
    } else {
      copy = {
        ...src,
        id: newLayerId(),
        name: `${src.name} copy`,
        mask,
        values: { ...src.values, color: [...src.values.color] as [number, number, number] },
        channels: { ...src.channels },
      };
    }
    r.setRenderTarget(null);
    this.insertAboveSelected(copy);
  }

  moveLayer(id: number, delta: number) {
    const idx = this.layers.findIndex((l) => l.id === id);
    const to = idx + delta;
    if (idx < 0 || to < 0 || to >= this.layers.length) return;
    const [l] = this.layers.splice(idx, 1);
    this.layers.splice(to, 0, l);
    this.invalidate();
    this.emit('layers');
  }

  /** Moves a layer to a stack index (bottom = 0). */
  moveLayerTo(id: number, index: number) {
    const idx = this.layers.findIndex((l) => l.id === id);
    if (idx < 0) return;
    const [l] = this.layers.splice(idx, 1);
    this.layers.splice(Math.max(0, Math.min(index, this.layers.length)), 0, l);
    this.invalidate();
    this.emit('layers');
  }

  addMask(id: number, fill: 'white' | 'black', generator?: Partial<GeneratorParams> & Pick<GeneratorParams, 'type'>) {
    const l = this.layers.find((x) => x.id === id);
    if (!l) return;
    if (!l.mask) {
      l.mask = { rt: createMaskRT(this.renderer, this.texSize, fill === 'white' ? 1 : 0), enabled: true, generator: null };
      this.renderer.setRenderTarget(null);
    }
    if (generator) l.mask.generator = { ...defaultGenerator(generator.type), ...generator };
    this.selectedId = id;
    this.part = generator ? 'content' : 'mask';
    this.invalidate();
    this.emit('layers');
    this.emit('selection');
  }

  removeMask(id: number) {
    const l = this.layers.find((x) => x.id === id);
    if (!l?.mask) return;
    this.painter.forgetLayer(l, 'mask');
    l.mask.rt.dispose();
    l.mask = null;
    this.part = 'content';
    this.invalidate();
    this.emit('layers');
    this.emit('selection');
    this.emit('history');
  }

  /** Changes to layer properties that don't alter the stack structure. */
  layerChanged(structural = false) {
    this.invalidate();
    if (structural) this.emit('layers');
  }

  // ---------------------------------------------------------------- brush
  setBrushMaterial(p: MaterialPreset) {
    this.brush.values = { ...p.values, color: [...p.values.color] as [number, number, number] };
    this.brush.materialName = p.name;
    this.brush.channels.color = this.brush.channels.roughness = this.brush.channels.metallic = true;
    this.brush.channels.height = p.values.height !== 0.5;
    this.emit('brush');
  }

  // ---------------------------------------------------------------- painting
  /** Returns an error message if the current target cannot be painted. */
  paintBlockedReason(): string | null {
    const l = this.selected;
    if (!this.ready || !this.mesh) return 'Load a mesh first.';
    if (!l) return 'Select or add a layer to paint on.';
    if (!l.visible) return 'The selected layer is hidden.';
    if (this.part === 'content' && l.kind === 'fill') return 'Fill layers are procedural — add a mask to the layer and paint the mask, or add a paint layer.';
    return null;
  }

  beginStroke(): boolean {
    const l = this.selected;
    if (!l || this.paintBlockedReason()) return false;
    return this.painter.beginStroke(l, this.part, this.viewport.camera, this.brush, this.tool === 'erase');
  }

  /** Fill (or clear) the whole selected layer / mask with the brush settings; undoable. */
  fillSelected(erase = false) {
    const l = this.selected;
    if (!l || this.painter.isPainting) return;
    if (this.part === 'content' && l.kind === 'fill') return;
    if (this.painter.fill(l, this.part, this.brush, erase)) {
      this.invalidate();
      this.emit('history');
    }
  }

  queueStamps(stamps: Stamp[]) {
    this.pendingStamps.push(...stamps);
  }

  endStroke() {
    if (this.pendingStamps.length) {
      this.painter.addStamps(this.pendingStamps);
      this.pendingStamps = [];
    }
    this.painter.endStroke();
    this.invalidate();
    this.emit('history');
  }

  undo() {
    if (this.painter.isPainting) return;
    const l = this.painter.undo();
    if (l) {
      this.invalidate();
      this.emit('history');
    }
  }

  redo() {
    if (this.painter.isPainting) return;
    const l = this.painter.redo();
    if (l) {
      this.invalidate();
      this.emit('history');
    }
  }

  // ---------------------------------------------------------------- project IO
  saveProject(): Uint8Array {
    if (!this.mesh) throw new Error('Nothing to save.');
    return saveProject(this.renderer, {
      texSize: this.texSize,
      meshSource: this.mesh.source,
      bake: this.bake,
      composite: this.composite,
      brush: this.brush,
      layers: this.layers,
    });
  }

  async loadProject(bytes: Uint8Array) {
    const p = readProject(bytes);
    this.setProgress(true, 'Loading project', 0);
    let mesh: PaintMesh;
    try {
      mesh = await loadMeshSource(p.meshSource);
    } finally {
      this.setProgress(false);
    }
    this.layers.forEach(disposeLayer);
    this.layers = [];
    this.texSize = p.json.texSize;
    this.bake = { ...DEFAULT_BAKE, ...p.json.bake };
    this.composite = { ...this.composite, ...p.json.composite };
    this.brush = { ...this.brush, ...p.json.brush };
    this.compositor.resize(this.texSize);
    this.painter.setTextureSize(this.texSize);
    await this.openMesh(mesh, false);
    this.layers = restoreLayers(this.renderer, this.copier, p);
    this.selectedId = this.layers[this.layers.length - 1]?.id ?? null;
    this.part = 'content';
    this.invalidate();
    this.emit('layers');
    this.emit('selection');
    this.emit('brush');
    this.emit('settings');
  }

  /** Small RGBA preview of a paint layer's color (for layer thumbnails). */
  layerThumbnail(l: Layer, part: PaintPart, size = 40): ImageData | null {
    const src = part === 'mask' ? l.mask?.rt : l.kind === 'paint' ? l.rt : null;
    if (!src) return null;
    const rt = createRT(size, size, { linear: true });
    this.copier.copy(this.renderer, [src.textures[0]], rt);
    const buf = new Uint8Array(size * size * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf);
    this.renderer.setRenderTarget(null);
    rt.dispose();
    const img = new ImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const s = ((size - 1 - y) * size + x) * 4;
        const d = (y * size + x) * 4;
        img.data[d] = buf[s];
        img.data[d + 1] = buf[s + 1];
        img.data[d + 2] = buf[s + 2];
        img.data[d + 3] = part === 'mask' ? 255 : buf[s + 3];
      }
    }
    return img;
  }
}
