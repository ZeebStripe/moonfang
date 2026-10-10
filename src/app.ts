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
import { MATERIALS, type MaterialPreset, type SmartLayerSpec, type SmartMaterial } from './data/materials';
import { importTextureSet, Library, mapTextureIds, TextureStore } from './engine/library';

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
    maps: null,
    tiling: 4,
    materialName: 'Custom',
    maskValue: 1,
  };
  progress: ProgressInfo = { active: false, label: '', value: 0 };
  /** decoded images used by textured materials */
  textures = new TextureStore();
  /** the user's own materials and smart materials (IndexedDB) */
  library = new Library(this.textures);

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
    this.painter.setContext(this.maps, this.textures);
    this.textures.onLoad(() => this.invalidate());
    void this.library.load();
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
        this.compositor.composite(this.layers, this.maps, this.composite, this.textures);
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
    if (preset?.maps) {
      l.maps = cloneMaps(preset.maps);
      l.tiling = preset.tiling ?? 4;
      l.channels.height = !!preset.maps.height || preset.values.height !== 0.5;
    }
    this.insertAboveSelected(l);
  }

  /** Built-in presets followed by the user's library. */
  get allMaterials(): MaterialPreset[] {
    return [...MATERIALS, ...this.library.materials];
  }

  findMaterial(id: string | undefined): MaterialPreset | undefined {
    return id ? this.allMaterials.find((m) => m.id === id) : undefined;
  }

  addSmartMaterial(sm: SmartMaterial) {
    const created: Layer[] = sm.layers.map((spec) => {
      const preset = this.findMaterial(spec.material);
      const values: MaterialValues = { ...DEFAULT_VALUES, ...preset?.values, ...spec.values };
      const l = createFillLayer(`${sm.name} · ${spec.name}`, values, spec.channels);
      l.variation = spec.variation ?? preset?.variation ?? 0;
      const maps = spec.maps ?? preset?.maps;
      if (maps) {
        l.maps = cloneMaps(maps);
        l.tiling = spec.tiling ?? preset?.tiling ?? 4;
      }
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
        maps: src.maps ? cloneMaps(src.maps) : null,
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
    this.brush.maps = p.maps ? cloneMaps(p.maps) : null;
    this.brush.tiling = p.tiling ?? 4;
    this.brush.materialName = p.name;
    this.brush.channels.color = this.brush.channels.roughness = this.brush.channels.metallic = true;
    this.brush.channels.height = !!p.maps?.height || p.values.height !== 0.5;
    this.emit('brush');
  }

  // ---------------------------------------------------------------- user library
  /** Creates a material from loose PBR images and adds it to the library. */
  async importTextureSet(files: File[]): Promise<MaterialPreset> {
    const data = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
    const res = await importTextureSet(data);
    await Promise.all(res.assets.map((a) => this.textures.add(a)));
    this.library.addMaterial(res.material);
    const m = res.material.maps!;
    const used = (['color', 'roughness', 'metallic', 'height'] as const).filter((k) => m[k]);
    this.toast(`Imported material "${res.material.name}" (${used.join(', ')})`);
    for (const s of res.skipped) this.toast(`Skipped ${s}`, 'warn');
    return res.material;
  }

  /** Stores a fill layer's material (values + maps) in the library. */
  saveFillAsMaterial(id: number, name?: string) {
    const l = this.layers.find((x) => x.id === id);
    if (!l || l.kind !== 'fill') return;
    const m: MaterialPreset = {
      id: `user_${Date.now().toString(36)}`,
      name: name || l.name,
      category: 'Custom',
      values: { ...l.values, color: [...l.values.color] as [number, number, number] },
      variation: l.variation,
      maps: l.maps ? cloneMaps(l.maps) : undefined,
      tiling: l.tiling,
      custom: true,
    };
    this.library.addMaterial(m);
    this.toast(`Saved material "${m.name}" to your library`);
  }

  /**
   * Turns fill layers (bottom→top, with their generator masks) into a reusable smart material.
   * Paint layers and hand-painted mask pixels are UV-specific and therefore left out.
   */
  saveLayersAsSmartMaterial(ids: number[], name: string): number {
    const chosen = this.layers.filter((l) => ids.includes(l.id));
    const fills = chosen.filter((l): l is Extract<Layer, { kind: 'fill' }> => l.kind === 'fill');
    if (!fills.length) {
      this.toast('Smart materials are built from fill layers — none selected.', 'warn');
      return 0;
    }
    const layers: SmartLayerSpec[] = fills.map((f) => {
      // Layers added from a smart material are named "<Smart> · <Layer>"; keep only the layer part.
      const dot = f.name.lastIndexOf(' · ');
      return {
        name: dot >= 0 ? f.name.slice(dot + 3) : f.name,
        values: { ...f.values, color: [...f.values.color] as [number, number, number] },
        channels: { ...f.channels },
        maps: f.maps ? cloneMaps(f.maps) : undefined,
        tiling: f.tiling,
        variation: f.variation,
        variationScale: f.variationScale,
        opacity: f.opacity,
        blend: f.blend,
        heightBlend: f.heightBlend,
        generator: f.mask?.enabled && f.mask.generator ? { ...f.mask.generator } : undefined,
      };
    });
    const colors = fills
      .map((f) => `rgb(${f.values.color.map((v) => Math.round(v * 255)).join(',')})`)
      .reverse()
      .slice(0, 3);
    while (colors.length < 3) colors.push(colors[colors.length - 1]);
    const sm: SmartMaterial = {
      id: `user_sm_${Date.now().toString(36)}`,
      name,
      preview: `radial-gradient(circle at 35% 30%, ${colors[0]} 0 38%, ${colors[1]} 39% 62%, ${colors[2]} 63%)`,
      layers,
      custom: true,
    };
    this.library.addSmart(sm);
    const skipped = chosen.length - fills.length;
    this.toast(`Saved smart material "${name}" (${layers.length} layers${skipped ? `, ${skipped} paint layer(s) skipped` : ''})`);
    return layers.length;
  }

  /** Texture ids referenced by the current layers and brush (embedded in project files). */
  usedTextureIds(): string[] {
    const ids = new Set<string>(mapTextureIds(this.brush.maps));
    for (const l of this.layers) if (l.kind === 'fill') mapTextureIds(l.maps).forEach((i) => ids.add(i));
    return [...ids];
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
      textures: this.usedTextureIds()
        .map((id) => this.textures.asset(id))
        .filter((a): a is NonNullable<typeof a> => !!a),
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
    // Older projects predate textured materials; keep the fields defined.
    const brush = { ...this.brush, ...p.json.brush };
    this.brush = { ...brush, maps: brush.maps ?? null, tiling: brush.tiling ?? 4 };
    await Promise.all(p.textures.map((t) => this.textures.add(t)));
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

function cloneMaps<T extends object>(m: T): T {
  return JSON.parse(JSON.stringify(m));
}
