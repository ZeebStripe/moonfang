import * as THREE from 'three';
import { Compositor, type CompositeSettings } from './engine/compositor';
import { Exporter } from './engine/exporter';
import { Copier, createRT, FullscreenPass } from './engine/gl';
import {
  createFillLayer,
  createMaskRT,
  createPaintLayer,
  createGroup,
  createPaintRT,
  defaultGenerator,
  disposeLayer,
  locateLayer,
  newLayerId,
  walkLayers,
  type GeneratorParams,
  type Layer,
  type MaterialValues,
} from './engine/layers';
import type { PaintMesh, TextureSetInfo } from './engine/meshLoader';
import { DEFAULT_BAKE, MeshMaps, type BakeSettings } from './engine/meshMaps';
import { HighPoly } from './engine/highPoly';
import { DEFAULT_STENCIL, Painter, swapPixels, type BrushSettings, type PaintPart, type Stamp } from './engine/painter';
import { captureTree, liveRefs, restoreTree, treeRefs, type HistoryEntry, type TreeState } from './engine/history';
import type { LayerMask } from './engine/layers';
import { collectProjectFiles, projectSets, readProject, restoreLayers } from './engine/project';
import { zipSync } from 'fflate';
import { Viewport } from './engine/viewport';
import { FacePicker, FaceSelection, subsetGeometry, type FaceMode, type TriRange } from './engine/faceSelect';
import { disposeMeshEdges, loadMeshSource } from './engine/meshLoader';
import { MATERIALS, type MaterialPreset, type SmartLayerSpec, type SmartMaterial } from './data/materials';
import { importTextureSet, Library, makeAsset, mapTextureIds, TextureStore } from './engine/library';
import { builtinTipTexture, importTipImage } from './engine/brushTips';

/** 'select' = polygon fill: select faces, then fill them or assign materials to them */
export type Tool = 'paint' | 'erase' | 'select';
export type ChangeKind = 'layers' | 'selection' | 'brush' | 'mesh' | 'view' | 'history' | 'settings' | 'tool' | 'autosave' | 'stencil' | 'set' | 'gpu' | 'faces';

/** One material of the mesh with its own layer stack, resolution, baked maps and composited textures. */
export interface TextureSet {
  info: TextureSetInfo;
  /** the set's triangles only (draw range over the shared mesh buffers) */
  geometry: THREE.BufferGeometry;
  /** the same triangles laid out flat at their UVs (position = (u, v, 0)): what the 2D view paints on */
  flat: THREE.BufferGeometry;
  texSize: number;
  layers: Layer[];
  selectedId: number | null;
  part: PaintPart;
  maps: MeshMaps;
  compositor: Compositor;
  dirty: boolean;
  /** layer tree as of the last undo step (the "before" of the next one) */
  committed: TreeState;
}

/**
 * History limits: total steps, steps holding full layer textures (strokes/fills), and the GPU memory those
 * texture snapshots may use (a 4096² paint layer snapshot alone is 320 MB, so big sets keep fewer steps).
 */
const HISTORY_LIMIT = 80;
const PIXEL_HISTORY_LIMIT = 24;
const PIXEL_HISTORY_BYTES = 1024 ** 3;

/** GPU memory of a stroke snapshot (RGBA8 per render target). */
function pixelEntryBytes(e: HistoryEntry<TextureSet>): number {
  return e.kind === 'pixels' ? e.entry.rt.width * e.entry.rt.height * 4 * e.entry.rt.textures.length : 0;
}

const DEFAULT_BRUSH_EXTRAS = {
  symmetry: 'off' as const,
  tip: 'round',
  angle: 0,
  followStroke: false,
  sizeJitter: 0,
  angleJitter: 0,
  scatter: 0,
  opacityJitter: 0,
  smoothing: 0,
};

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ProgressInfo {
  active: boolean;
  label: string;
  value: number;
}

const DEFAULT_VALUES: MaterialValues = { color: [0.5, 0.5, 0.5], roughness: 0.5, metallic: 0, height: 0.5 };

/** Copy of a mesh laid out flat at its UVs: position = (u, v, 0), normal = +Z, uv kept. */
function flattenToUV(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const pos = new Float32Array(uv.count * 3);
  const nrm = new Float32Array(uv.count * 3);
  for (let i = 0; i < uv.count; i++) {
    pos[i * 3] = uv.getX(i);
    pos[i * 3 + 1] = uv.getY(i);
    nrm[i * 3 + 2] = 1;
  }
  const flat = new THREE.BufferGeometry();
  flat.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  flat.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  flat.setAttribute('uv', uv);
  return flat;
}

export class App {
  viewport: Viewport;
  renderer: THREE.WebGLRenderer;
  fs = new FullscreenPass();
  copier = new Copier(this.fs);
  painter: Painter;
  exporter: Exporter;

  mesh: PaintMesh | null = null;
  /** one per material of the mesh; each has its own layer stack, resolution and baked maps */
  sets: TextureSet[] = [];
  activeSet = 0;
  private emptySet: TextureSet;
  tool: Tool = 'paint';
  bake: BakeSettings = { ...DEFAULT_BAKE };
  /** optional high-poly reference: projected into the baked normal / AO / curvature maps */
  highPoly: HighPoly | null = null;
  composite: CompositeSettings = { normalStrength: 1, aoStrength: 1 };
  brush: BrushSettings = {
    size: 36,
    hardness: 0.6,
    opacity: 1,
    spacing: 0.12,
    pressureSize: true,
    pressureOpacity: false,
    values: { color: [0.8, 0.8, 0.78], roughness: 0.45, metallic: 0, height: 0.5, emissive: [1, 0.55, 0.15], opacity: 1 },
    channels: { color: true, roughness: true, metallic: true, height: false, normal: false, emissive: false, opacity: false },
    maps: null,
    tiling: 4,
    materialName: 'Custom',
    maskValue: 1,
    symmetry: 'off',
    tip: 'round',
    angle: 0,
    followStroke: false,
    sizeJitter: 0,
    angleJitter: 0,
    scatter: 0,
    opacityJitter: 0,
    smoothing: 0,
    stencil: { ...DEFAULT_STENCIL },
  };
  progress: ProgressInfo = { active: false, label: '', value: 0 };
  /** decoded images used by textured materials */
  textures = new TextureStore();
  /** the user's own materials and smart materials (IndexedDB) */
  library = new Library(this.textures);

  private ready = false;
  private pendingStamps: Stamp[] = [];
  private listeners = new Set<(k: ChangeKind) => void>();
  private progressListeners = new Set<(p: ProgressInfo) => void>();
  private toastListeners = new Set<(msg: string, kind: 'info' | 'warn' | 'error', action?: ToastAction) => void>();

  constructor(canvas: HTMLCanvasElement) {
    this.viewport = new Viewport(canvas);
    this.renderer = this.viewport.renderer;
    // GPU-side textures (every layer) are gone after a context loss; the last autosave is the way back (see the
    // 'gpu' dialog). Autosave stops so the good snapshots aren't overwritten with blank readbacks.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      if (this.contextLost) return;
      this.contextLost = true;
      this.emit('gpu');
    });
    this.emptySet = {
      info: { name: '—', start: 0, count: 0 },
      geometry: new THREE.BufferGeometry(),
      flat: new THREE.BufferGeometry(),
      texSize: 2048,
      layers: [],
      selectedId: null,
      part: 'content',
      maps: new MeshMaps(this.renderer, this.fs),
      compositor: new Compositor(this.renderer, this.fs),
      dirty: false,
      committed: captureTree([], null),
    };
    this.painter = new Painter(this.renderer, this.fs, this.copier);
    this.picker = new FacePicker(this.renderer);
    this.textures.onLoad(() => this.invalidate(true));
    // Library contents (e.g. imported brush tips) appear in the brush panel.
    this.library.onChange(() => this.emit('brush'));
    void this.library.load();
    this.exporter = new Exporter(this.renderer, this.fs);
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
  onToast(fn: (msg: string, kind: 'info' | 'warn' | 'error', action?: ToastAction) => void) {
    this.toastListeners.add(fn);
  }
  emit(k: ChangeKind) {
    for (const fn of this.listeners) fn(k);
  }
  /** `action` adds a button to the toast (and keeps it up longer). */
  toast(msg: string, kind: 'info' | 'warn' | 'error' = 'info', action?: ToastAction) {
    for (const fn of this.toastListeners) fn(msg, kind, action);
  }
  private setProgress(active: boolean, label = '', value = 0) {
    this.progress = { active, label, value };
    for (const fn of this.progressListeners) fn(this.progress);
  }

  /** Request a recomposite on the next frame: of the active texture set, or of all sets (`all`). */
  invalidate(all = false) {
    if (all) for (const s of this.sets) s.dirty = true;
    else this.set.dirty = true;
    this.revision++;
  }

  // ---------------------------------------------------------------- active texture set
  /** The active texture set (an empty placeholder until a mesh is loaded). */
  get set(): TextureSet {
    return this.sets[this.activeSet] ?? this.emptySet;
  }
  get layers(): Layer[] {
    return this.set.layers;
  }
  set layers(v: Layer[]) {
    this.set.layers = v;
  }
  get selectedId(): number | null {
    return this.set.selectedId;
  }
  set selectedId(v: number | null) {
    this.set.selectedId = v;
  }
  get part(): PaintPart {
    return this.set.part;
  }
  set part(v: PaintPart) {
    this.set.part = v;
  }
  get texSize(): number {
    return this.set.texSize;
  }
  get maps(): MeshMaps {
    return this.set.maps;
  }
  get compositor(): Compositor {
    return this.set.compositor;
  }

  /** Switch which texture set is painted and shown in the layer stack. */
  activateSet(i: number) {
    if (!this.sets[i] || this.painter.isPainting) return;
    this.flushCommit();
    this.activeSet = i;
    const s = this.set;
    this.bindPainterGeometry();
    this.viewport.showUVSet(i, s.geometry);
    this.painter.setContext(s.maps, this.textures);
    this.painter.setTextureSize(s.texSize);
    if (this.viewport.mode === 'mask') s.dirty = true;
    this.refreshFaceOverlay();
    this.emit('set');
    this.emit('layers');
    this.emit('selection');
    this.emit('settings');
  }

  private createSet(info: TextureSetInfo, size: number): TextureSet {
    const mesh = this.mesh!;
    // A view of just this set's triangles (shares the vertex buffers with the full mesh).
    const geometry = new THREE.BufferGeometry();
    for (const [k, a] of Object.entries(mesh.geometry.attributes)) geometry.setAttribute(k, a);
    geometry.setDrawRange(info.start, info.count);
    const flat = new THREE.BufferGeometry();
    for (const [k, a] of Object.entries(this.flatGeometry!.attributes)) flat.setAttribute(k, a);
    flat.setDrawRange(info.start, info.count);
    const compositor = new Compositor(this.renderer, this.fs);
    compositor.resize(size);
    return {
      info,
      geometry,
      flat,
      texSize: size,
      layers: [],
      selectedId: null,
      part: 'content',
      maps: new MeshMaps(this.renderer, this.fs),
      compositor,
      dirty: true,
      committed: captureTree([], null),
    };
  }

  private defaultLayers(s: TextureSet) {
    const base = createFillLayer('Base', DEFAULT_VALUES);
    base.channels.height = false;
    const paint = createPaintLayer(this.renderer, s.texSize, 'Layer 1');
    s.layers = [base, paint];
    s.selectedId = paint.id;
    s.part = 'content';
  }

  /** Runs before the open document is replaced by another mesh or project (autosave snapshots it). */
  beforeReplace: (() => Promise<void>) | null = null;

  /** Bumped on every change to the document; autosave compares against it. */
  revision = 0;
  /** The WebGL context was lost: the document's GPU data is gone until the app is reloaded. */
  contextLost = false;
  lastAutosave = 0;

  get busy() {
    return this.progress.active;
  }

  // ---------------------------------------------------------------- frame loop
  private tick() {
    if (this.ready) {
      if (this.pendingStamps.length) {
        this.painter.addStamps(this.pendingStamps);
        this.pendingStamps = [];
        this.set.dirty = true;
      }
      for (const s of this.sets) {
        if (!s.dirty) continue;
        s.compositor.composite(s.layers, s.maps, this.composite, this.textures);
        if (s === this.set && this.viewport.mode === 'mask') s.compositor.renderMaskPreview(this.selected, s.maps);
        s.dirty = false;
      }
    }
    this.viewport.render();
  }

  // ---------------------------------------------------------------- mesh & baking
  /**
   * @param layers 'reset' = fresh default stacks, 'keep' = keep the current stacks if the set count matches
   *               (UVs are assumed unchanged), or one ready-made stack per set (project loading; null = default stack)
   * @param sizes  texture resolution per set (defaults to the previous size or 2048)
   */
  async openMesh(mesh: PaintMesh, layers: 'reset' | 'keep' | (Layer[] | null)[] = 'reset', sizes?: number[]) {
    // Ready-made stacks come from loadProject, which has run the hook before changing anything.
    if (!Array.isArray(layers)) await this.beforeReplace?.().catch(() => undefined);
    this.ready = false;
    const old = this.sets;
    const keep = layers === 'keep' && old.length === mesh.sets.length;
    if (layers === 'keep' && !keep) this.toast('The new mesh has a different number of texture sets — starting fresh layer stacks.', 'warn');
    // The high poly belongs to the model: refit it when the same model is reloaded, drop it for a new one.
    if (this.highPoly && typeof layers === 'string') {
      const hp = this.highPoly;
      this.highPoly = null;
      if (layers === 'keep') this.highPoly = await hp.refit(mesh).catch(() => null);
      hp.dispose();
    }
    const oldMesh = this.mesh;
    const oldFlat = this.flatGeometry;
    this.mesh = mesh;
    this.flatGeometry = flattenToUV(mesh.geometry);
    this.faces.reset(mesh.topology, mesh.geometry.attributes.uv as THREE.BufferAttribute);
    this.viewport.setGeometry(mesh.geometry, mesh.sets.length);
    this.painter.setMesh(mesh.geometry);
    this.clearHistory();
    this.sets = mesh.sets.map((info, i) => this.createSet(info, sizes?.[i] ?? old[i]?.texSize ?? 2048));
    for (const [i, s] of old.entries()) {
      if (keep) {
        this.sets[i].layers = s.layers;
        this.sets[i].selectedId = s.selectedId;
      } else s.layers.forEach(disposeLayer);
      s.maps.dispose();
      s.compositor.dispose();
    }
    // Free the previous GPU buffers. The set views and UV layouts share attributes with their mesh; should one of
    // those still be in use (same mesh reopened), three.js simply uploads it again on the next draw.
    for (const s of old) {
      s.geometry.dispose();
      s.flat.dispose();
    }
    oldFlat?.dispose();
    if (oldMesh && oldMesh !== mesh) {
      disposeMeshEdges(oldMesh);
      oldMesh.geometry.dispose();
    }
    this.activeSet = 0;
    this.activateSet(0);
    await this.rebake();
    if (Array.isArray(layers)) {
      this.sets.forEach((s, i) => {
        const stack = layers[i];
        if (!stack) return this.defaultLayers(s);
        s.layers = stack;
        s.selectedId = stack[stack.length - 1]?.id ?? null;
        s.part = 'content';
      });
    } else if (layers === 'reset' || !keep) this.sets.forEach((s) => this.defaultLayers(s));
    this.rebaseline();
    for (const w of mesh.warnings) this.toast(w, 'warn');
    this.emit('mesh');
    this.emit('set');
    this.emit('layers');
    this.emit('selection');
  }

  /**
   * Bakes mesh maps for the given sets (default: all). Returns false when the bake failed; the app stays usable
   * (with whatever maps were baked) instead of freezing.
   */
  async rebake(sets: TextureSet[] = this.sets): Promise<boolean> {
    if (!this.mesh || this.busy || this.painter.isPainting) return false;
    this.ready = false;
    this.setProgress(true, 'Baking mesh maps', 0);
    let ok = true;
    let done = 0;
    try {
      for (const [n, s] of sets.entries()) {
        const prefix = this.sets.length > 1 ? `${s.info.name} — ` : '';
        await s.maps.bake(
          this.mesh,
          s.geometry,
          s.texSize,
          this.bake,
          (v, label) => this.setProgress(true, `Baking ${prefix}${label}`, (n + v) / sets.length),
          this.highPoly,
        );
        this.bindViewportTextures(s);
        done++;
      }
    } catch (e) {
      ok = false;
      console.error('Bake failed', e);
      this.toast(`Baking mesh maps failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
      // The failed set has half-built maps; sets the bake didn't reach may have none (or the wrong size).
      for (const [n, s] of sets.entries()) {
        if (n === done || s.maps.size !== s.texSize) s.maps.placeholder(s.texSize);
        this.bindViewportTextures(s);
      }
    } finally {
      this.setProgress(false);
    }
    this.ready = true;
    this.invalidate(true);
    return ok;
  }

  private bindViewportTextures(s: TextureSet) {
    const f = s.compositor.final;
    this.viewport.setTextures(this.sets.indexOf(s), {
      baseColor: f.textures[0],
      orm: f.textures[1],
      normal: f.textures[2],
      emissive: f.textures[3],
      coverage: s.maps.coverage.texture,
      meshA: s.maps.meshATex,
      meshB: s.maps.meshBTex,
      mask: s.compositor.maskPreview.texture,
    });
  }

  /** Loads (or with null, removes) the high-poly reference mesh. Does not rebake. */
  async setHighPoly(file: { name: string; bytes: ArrayBuffer } | null) {
    if (!this.mesh || this.busy) return;
    const next = file ? await HighPoly.load(file.name, file.bytes, this.mesh) : null;
    this.highPoly?.dispose();
    this.highPoly = next;
    this.emit('settings');
  }

  /** Changes the active texture set's resolution, resampling its layers. */
  async setResolution(size: number) {
    const s = this.set;
    if (size === s.texSize || !this.mesh || this.busy || this.painter.isPainting) return;
    const r = this.renderer;
    for (const l of walkLayers(s.layers)) {
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
    s.texSize = size;
    s.compositor.resize(size);
    this.painter.setTextureSize(size);
    // Stroke snapshots of this set have the old size.
    this.clearHistory();
    await this.rebake([s]);
    this.emit('settings');
    this.emit('history');
  }

  // ---------------------------------------------------------------- 2D UV view
  uvView = false;
  private flatGeometry: THREE.BufferGeometry | null = null;

  /** Switches between the 3D viewport and the 2D UV view (both paint). */
  setUVView(on: boolean) {
    if (this.painter.isPainting || on === this.uvView) return;
    this.uvView = on;
    this.viewport.setUVView(on);
    this.bindPainterGeometry();
    this.refreshFaceOverlay();
    this.emit('view');
  }

  /** Strokes are projected onto the 3D mesh, or onto its flat UV layout in the 2D view. */
  private bindPainterGeometry() {
    const s = this.set;
    if (!this.mesh) return;
    this.painter.setMesh(this.uvView ? s.flat : this.mesh.geometry);
    this.painter.setUVGeometry(this.uvView ? s.flat : s.geometry);
  }

  // ---------------------------------------------------------------- selection
  get selected(): Layer | null {
    return this.selectedId === null ? null : (locateLayer(this.layers, this.selectedId)?.layer ?? null);
  }

  findLayer(id: number): Layer | null {
    return locateLayer(this.layers, id)?.layer ?? null;
  }

  /** Every layer in the tree, folders included (depth-first). */
  get allLayers(): Layer[] {
    return [...walkLayers(this.layers)];
  }

  select(id: number, part: PaintPart = 'content') {
    const l = this.findLayer(id);
    if (!l) return;
    this.selectedId = id;
    this.part = part === 'mask' && l.mask ? 'mask' : 'content';
    if (this.viewport.mode === 'mask') this.invalidate();
    this.emit('selection');
  }

  setTool(t: Tool) {
    this.tool = t;
    this.refreshFaceOverlay();
    this.emit('tool');
  }

  // ---------------------------------------------------------------- face selection (polygon fill)
  faces = new FaceSelection();
  private picker: FacePicker;

  /** The active texture set's triangles. */
  get faceRange(): TriRange {
    const i = this.set.info;
    return [i.start / 3, (i.start + i.count) / 3];
  }

  private syncPicker(): boolean {
    if (!this.ready || !this.mesh || !this.flatGeometry) return false;
    this.picker.update(this.uvView ? this.flatGeometry : this.mesh.geometry, this.viewport.activeCamera, this.faceRange);
    return true;
  }

  /** The active set's triangle visible at a drawing-buffer pixel (origin bottom-left), or -1. */
  pickFace(x: number, y: number): number {
    return this.syncPicker() ? this.picker.at(x, y) : -1;
  }

  /** The active set's triangles visible inside a drawing-buffer rectangle, grown by the selection mode. */
  facesInRect(x0: number, y0: number, x1: number, y1: number): number[] {
    return this.syncPicker() ? this.faces.expand(this.picker.inRect(x0, y0, x1, y1), this.faceRange) : [];
  }

  /** Grows picked triangles into polygons / UV islands / mesh parts (the selection mode). */
  expandFaces(tris: number[]): number[] {
    return this.faces.expand(tris, this.faceRange);
  }

  selectFaces(tris: number[], op: 'add' | 'remove') {
    if (!tris.length) return;
    this.faces.apply(tris, op);
    this.facesChanged();
  }

  selectAllFaces(on: boolean) {
    if (!this.mesh) return;
    this.faces.setAll(this.faceRange, on ? 1 : 0);
    this.facesChanged();
  }

  invertFaces() {
    if (!this.mesh) return;
    this.faces.invert(this.faceRange);
    this.facesChanged();
  }

  setFaceMode(mode: FaceMode) {
    this.faces.mode = mode;
    this.emit('faces');
  }

  get selectedFaceCount(): number {
    return this.mesh ? this.faces.count(this.faceRange) : 0;
  }

  private facesChanged() {
    this.refreshFaceOverlay();
    this.emit('faces');
  }

  private overlayGeometry(tris: number[]): THREE.BufferGeometry {
    return subsetGeometry(this.uvView ? this.flatGeometry! : this.mesh!.geometry, tris, ['position']);
  }

  /** The selection is shown while the polygon fill tool is active (in the 3D or UV view, whichever is open). */
  refreshFaceOverlay() {
    const tris = this.tool === 'select' && this.mesh ? this.faces.list(this.faceRange) : [];
    this.viewport.setFaceOverlay('sel', tris.length ? this.overlayGeometry(tris) : null);
    this.hoverFaces(null);
  }

  /** Highlights the faces a click would select. */
  hoverFaces(tris: number[] | null) {
    this.viewport.setFaceOverlay('hover', tris?.length && this.tool === 'select' && this.mesh ? this.overlayGeometry(tris) : null);
  }

  /** The selected faces of the active set as UV-space geometry (null, with a hint, when there are none). */
  private selectedFaceGeometry(): THREE.BufferGeometry | null {
    if (!this.ready || !this.mesh || this.painter.isPainting) return null;
    const tris = this.faces.list(this.faceRange);
    if (!tris.length) {
      this.toast('Select some faces first: Polygon Fill tool (P), then click or Shift+drag on the model.', 'warn');
      return null;
    }
    return subsetGeometry(this.mesh.geometry, tris);
  }

  /** A mask that shows its layer on the given faces only. */
  private faceMask(faces: THREE.BufferGeometry): LayerMask {
    const rt = createMaskRT(this.renderer, this.texSize, 0);
    this.painter.drawFaces(rt, faces, 1);
    return { rt, enabled: true, generator: null };
  }

  /** Assigns a material to the selected faces: a new fill layer masked to them (the brush material by default). */
  assignMaterialToFaces(preset?: MaterialPreset) {
    const g = this.selectedFaceGeometry();
    if (!g) return;
    const mask = this.faceMask(g);
    g.dispose();
    if (preset) return this.addFillLayer(preset, mask);
    const b = this.brush;
    const l = createFillLayer(b.materialName === 'Custom' ? this.nextName('Fill') : b.materialName, b.values, b.channels);
    if (b.maps) {
      l.maps = cloneMaps(b.maps);
      l.tiling = b.tiling;
    }
    l.mask = mask;
    this.insertAboveSelected('Assign material to faces', l);
  }

  /** Assigns a smart material to the selected faces: its folder is masked to them. */
  assignSmartMaterialToFaces(sm: SmartMaterial) {
    const g = this.selectedFaceGeometry();
    if (!g) return;
    const mask = this.faceMask(g);
    g.dispose();
    this.addSmartMaterial(sm, mask);
  }

  /** Shows (reveal) or hides the selected layer on the selected faces through its mask; adds a mask if needed. */
  maskFaces(reveal: boolean) {
    const l = this.selected;
    if (!l) return this.toast('Select a layer first.', 'warn');
    const g = this.selectedFaceGeometry();
    if (!g) return;
    if (!l.mask) {
      // A new mask starts as the opposite, so the selected faces are the only ones that differ.
      const rt = createMaskRT(this.renderer, this.texSize, reveal ? 0 : 1);
      this.painter.drawFaces(rt, g, reveal ? 1 : 0);
      l.mask = { rt, enabled: true, generator: null };
      this.invalidate();
      this.commitLayers(reveal ? 'Mask to selected faces' : 'Hide on selected faces');
      this.emit('layers');
      this.emit('selection');
    } else {
      const entry = this.painter.fillFaces(l, 'mask', { ...this.brush, opacity: 1, maskValue: 1 }, !reveal, g);
      if (entry) {
        this.invalidate();
        this.pushHistory({ kind: 'pixels', label: reveal ? 'Show on selected faces' : 'Hide on selected faces', entry });
        this.emit('layers');
      }
    }
    g.dispose();
  }

  /** Fills (or erases) the selected faces of the selected paint layer with the brush. */
  paintFaces(erase = false) {
    const l = this.selected;
    if (!l || l.kind !== 'paint') return this.toast('Select a paint layer to fill faces with the brush.', 'warn');
    const g = this.selectedFaceGeometry();
    if (!g) return;
    const entry = this.painter.fillFaces(l, 'content', this.brush, erase, g);
    g.dispose();
    if (entry) {
      this.invalidate();
      this.pushHistory({ kind: 'pixels', label: erase ? 'Erase faces' : 'Fill faces', entry });
      this.emit('layers');
    }
  }

  // ---------------------------------------------------------------- layer operations
  /** Inserts above the selected layer, in the same folder as it. */
  private insertAboveSelected(label: string, ...ls: Layer[]) {
    const loc = this.selectedId === null ? null : locateLayer(this.layers, this.selectedId);
    if (loc) loc.list.splice(loc.index + 1, 0, ...ls);
    else this.layers.push(...ls);
    this.selectedId = ls[ls.length - 1].id;
    this.part = 'content';
    this.invalidate();
    this.commitLayers(label);
    this.emit('layers');
    this.emit('selection');
  }

  private nextName(base: string) {
    let i = 1;
    const names = new Set(this.allLayers.map((l) => l.name));
    while (names.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  }

  addPaintLayer() {
    this.insertAboveSelected('Add paint layer', createPaintLayer(this.renderer, this.texSize, this.nextName('Layer')));
  }

  /** New folder above the selection; with `wrapSelected` the selected layer is moved into it. */
  addGroup(wrapSelected = false) {
    const group = createGroup(this.nextName('Folder'));
    const loc = this.selectedId === null ? null : locateLayer(this.layers, this.selectedId);
    if (wrapSelected && loc) {
      loc.list.splice(loc.index, 1, group);
      group.children.push(loc.layer);
      group.name = `${loc.layer.name} folder`;
      this.selectedId = group.id;
      this.part = 'content';
      this.invalidate();
      this.commitLayers('Group layer');
      this.emit('layers');
      this.emit('selection');
      return;
    }
    this.insertAboveSelected('Add folder', group);
  }

  addFillLayer(preset?: MaterialPreset, mask: LayerMask | null = null) {
    const l = createFillLayer(preset ? preset.name : this.nextName('Fill'), preset?.values ?? DEFAULT_VALUES);
    l.mask = mask;
    if (preset?.variation) l.variation = preset.variation;
    if (preset?.maps) {
      l.maps = cloneMaps(preset.maps);
      l.tiling = preset.tiling ?? 4;
      l.channels.height = !!preset.maps.height || preset.values.height !== 0.5;
      l.channels.normal = !!preset.maps.normal;
    }
    this.insertAboveSelected(mask ? 'Assign material to faces' : 'Add fill layer', l);
  }

  /** Built-in presets followed by the user's library. */
  get allMaterials(): MaterialPreset[] {
    return [...MATERIALS, ...this.library.materials];
  }

  findMaterial(id: string | undefined): MaterialPreset | undefined {
    return id ? this.allMaterials.find((m) => m.id === id) : undefined;
  }

  addSmartMaterial(sm: SmartMaterial, mask: LayerMask | null = null) {
    const created: Layer[] = sm.layers.map((spec) => {
      const preset = this.findMaterial(spec.material);
      const values: MaterialValues = { ...DEFAULT_VALUES, ...preset?.values, ...spec.values };
      const l = createFillLayer(spec.name, values, spec.channels);
      l.variation = spec.variation ?? preset?.variation ?? 0;
      const maps = spec.maps ?? preset?.maps;
      if (maps) {
        l.maps = cloneMaps(maps);
        l.tiling = spec.tiling ?? preset?.tiling ?? 4;
        if (maps.normal && spec.channels?.normal === undefined) l.channels.normal = true;
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
    // A smart material arrives as a folder.
    const folder = createGroup(sm.name, created);
    folder.mask = mask;
    this.insertAboveSelected(mask ? 'Assign smart material to faces' : 'Add smart material', folder);
    this.toast(`Added smart material "${sm.name}" (${created.length} layers)`);
  }

  deleteLayer(id: number) {
    const loc = locateLayer(this.layers, id);
    if (!loc) return;
    // Not disposed here: the undo history still refers to it (see dropEntries).
    loc.list.splice(loc.index, 1);
    if (this.selectedId !== null && !this.findLayer(this.selectedId)) {
      const next = loc.list[Math.min(loc.index, loc.list.length - 1)] ?? loc.parent ?? this.layers[this.layers.length - 1];
      this.selectedId = next?.id ?? null;
      this.part = 'content';
    }
    this.invalidate();
    this.commitLayers('Delete layer');
    this.emit('layers');
    this.emit('selection');
  }

  duplicateLayer(id: number) {
    const src = this.findLayer(id);
    if (!src) return;
    const copy = this.cloneLayer(src);
    copy.name = `${src.name} copy`;
    this.renderer.setRenderTarget(null);
    this.insertAboveSelected('Duplicate layer', copy);
  }

  /** Deep copy including GPU textures and folder contents. */
  private cloneLayer(src: Layer): Layer {
    const r = this.renderer;
    let mask = null;
    if (src.mask) {
      const rt = createMaskRT(r, this.texSize, 1);
      this.copier.copy(r, [src.mask.rt.texture], rt);
      mask = { ...src.mask, rt, generator: src.mask.generator ? { ...src.mask.generator } : null };
    }
    if (src.kind === 'paint') {
      const rt = createPaintRT(this.texSize);
      this.copier.copy(r, src.rt.textures, rt);
      return { ...src, id: newLayerId(), rt, mask };
    }
    if (src.kind === 'group') return { ...src, id: newLayerId(), mask, children: src.children.map((c) => this.cloneLayer(c)) };
    return {
      ...src,
      id: newLayerId(),
      mask,
      values: { ...src.values, color: [...src.values.color] as [number, number, number] },
      channels: { ...src.channels },
      maps: src.maps ? cloneMaps(src.maps) : null,
    };
  }

  /** Moves a layer up (+1) or down (−1) within its folder. */
  moveLayer(id: number, delta: number) {
    const loc = locateLayer(this.layers, id);
    if (!loc) return;
    const to = loc.index + delta;
    if (to < 0 || to >= loc.list.length) return;
    loc.list.splice(loc.index, 1);
    loc.list.splice(to, 0, loc.layer);
    this.invalidate();
    this.commitLayers('Move layer');
    this.emit('layers');
  }

  /** Drag & drop: place `id` above / below `targetId`, or inside folder `targetId`. */
  moveLayerRelative(id: number, targetId: number, where: 'above' | 'below' | 'into') {
    if (id === targetId) return;
    const loc = locateLayer(this.layers, id);
    if (!loc) return;
    // A folder cannot be moved into itself or its descendants.
    if (loc.layer.kind === 'group' && [...walkLayers(loc.layer.children)].some((l) => l.id === targetId)) return;
    loc.list.splice(loc.index, 1);
    const target = locateLayer(this.layers, targetId);
    if (!target) {
      loc.list.splice(loc.index, 0, loc.layer);
      return;
    }
    if (where === 'into' && target.layer.kind === 'group') {
      target.layer.children.push(loc.layer);
      target.layer.collapsed = false;
    } else {
      // Lists are stored bottom → top; "above" in the panel means a higher index.
      target.list.splice(where === 'above' ? target.index + 1 : target.index, 0, loc.layer);
    }
    this.invalidate();
    this.commitLayers('Move layer');
    this.emit('layers');
  }

  addMask(id: number, fill: 'white' | 'black', generator?: Partial<GeneratorParams> & Pick<GeneratorParams, 'type'>) {
    const l = this.findLayer(id);
    if (!l) return;
    if (!l.mask) {
      l.mask = { rt: createMaskRT(this.renderer, this.texSize, fill === 'white' ? 1 : 0), enabled: true, generator: null };
      this.renderer.setRenderTarget(null);
    }
    if (generator) l.mask.generator = { ...defaultGenerator(generator.type), ...generator };
    this.selectedId = id;
    this.part = generator ? 'content' : 'mask';
    this.invalidate();
    this.commitLayers(generator ? 'Add generator' : 'Add mask');
    this.emit('layers');
    this.emit('selection');
  }

  removeMask(id: number) {
    const l = this.findLayer(id);
    if (!l?.mask) return;
    l.mask = null; // kept alive by the undo history
    this.part = 'content';
    this.invalidate();
    this.commitLayers('Remove mask');
    this.emit('layers');
    this.emit('selection');
  }

  /**
   * Changes to layer properties (sliders, toggles, renames…). Edits within a short pause are merged into one
   * undo step, so dragging a slider is undone in one go.
   */
  layerChanged(structural = false) {
    this.invalidate();
    this.scheduleCommit();
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
    this.brush.channels.normal = !!p.maps?.normal;
    this.brush.channels.emissive = this.brush.channels.opacity = false;
    this.brush.values.emissive ??= [1, 0.55, 0.15];
    this.brush.values.opacity ??= 1;
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
    const l = this.findLayer(id);
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
    const chosen = this.allLayers.filter((l) => ids.includes(l.id) && l.kind !== 'group');
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

  /** Brush tip texture, or null for the procedural round tip (or a tip whose image is missing). */
  tipTexture() {
    const id = this.brush.tip;
    const user = this.library.tips.find((t) => t.id === id);
    return user ? this.textures.get(user.assetId) : builtinTipTexture(id);
  }

  async importBrushTip(file: File) {
    const { asset } = await importTipImage(file.name, new Uint8Array(await file.arrayBuffer()));
    await this.textures.add(asset);
    const tip = { id: `tip_${asset.id}`, name: file.name.replace(/\.[^.]+$/, ''), assetId: asset.id };
    this.library.addTip(tip);
    this.brush.tip = tip.id;
    this.emit('brush');
    this.toast(`Brush tip "${tip.name}" imported`);
  }

  /** Loads an image as the stencil, centred in the viewport. */
  async loadStencil(file: File) {
    const asset = await makeAsset(file.name, new Uint8Array(await file.arrayBuffer()));
    await this.textures.add(asset);
    const canvas = this.viewport.canvas;
    const st = this.brush.stencil;
    st.imageId = asset.id;
    st.enabled = true;
    st.x = canvas.clientWidth / 2;
    st.y = canvas.clientHeight / 2;
    st.width = Math.min(canvas.clientWidth, canvas.clientHeight) * 0.7;
    st.rotation = 0;
    this.emit('brush');
    this.emit('stencil');
    this.toast('Stencil loaded — hold S and drag to move, wheel to scale, Shift+wheel to rotate');
  }

  /** Texture ids referenced by every texture set's layers and the brush (embedded in project files). */
  usedTextureIds(): string[] {
    const ids = new Set<string>(mapTextureIds(this.brush.maps));
    if (this.brush.stencil.imageId) ids.add(this.brush.stencil.imageId);
    const tip = this.library.tips.find((t) => t.id === this.brush.tip);
    if (tip) ids.add(tip.assetId);
    for (const s of this.sets) {
      for (const l of walkLayers(s.layers)) if (l.kind === 'fill') mapTextureIds(l.maps).forEach((i) => ids.add(i));
    }
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
    if (this.part === 'content' && l.kind === 'group') return 'Folders hold layers — select a layer inside it, or add a mask to the folder and paint that.';
    return null;
  }

  beginStroke(): boolean {
    const l = this.selected;
    if (!l || this.paintBlockedReason()) return false;
    // Mirror symmetry is a 3D notion; in the UV view it would mirror across the UV square.
    const brush = this.uvView ? { ...this.brush, symmetry: 'off' as const } : this.brush;
    return this.painter.beginStroke(l, this.part, this.viewport.activeCamera, brush, this.tool === 'erase', {
      tip: this.tipTexture(),
      stencil: this.textures.get(this.brush.stencil.imageId ?? undefined),
      dpr: this.renderer.getPixelRatio(),
    });
  }

  /** Fill (or clear) the whole selected layer / mask with the brush settings; undoable. */
  fillSelected(erase = false) {
    const l = this.selected;
    if (!l || this.painter.isPainting) return;
    if (this.part === 'content' && l.kind !== 'paint') return;
    const entry = this.painter.fill(l, this.part, this.brush, erase);
    if (entry) {
      this.invalidate();
      this.pushHistory({ kind: 'pixels', label: erase ? 'Clear' : 'Fill', entry });
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
    const entry = this.painter.endStroke();
    this.invalidate();
    if (entry) this.pushHistory({ kind: 'pixels', label: this.tool === 'erase' ? 'Erase' : 'Paint stroke', entry });
  }

  // ---------------------------------------------------------------- history
  private undoStack: HistoryEntry<TextureSet>[] = [];
  private redoStack: HistoryEntry<TextureSet>[] = [];
  private commitTimer = 0;
  private pendingCommitSet: TextureSet | null = null;

  get canUndo() {
    return this.undoStack.length > 0 || !!this.commitTimer;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  get undoLabel(): string | null {
    return this.commitTimer ? 'Edit layer' : (this.undoStack[this.undoStack.length - 1]?.label ?? null);
  }
  get redoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }

  /** Records the set's layer-tree changes since the last step as one undo step (no-op if nothing changed). */
  commitLayers(label = 'Edit layer', set: TextureSet = this.set) {
    clearTimeout(this.commitTimer);
    this.commitTimer = 0;
    this.pendingCommitSet = null;
    if (!this.sets.includes(set)) return;
    const after = captureTree(set.layers, set.selectedId);
    if (after.key === set.committed.key) return;
    const before = set.committed;
    set.committed = after;
    this.pushHistory({ kind: 'tree', label, owner: set, before, after });
  }

  private scheduleCommit() {
    if (this.pendingCommitSet && this.pendingCommitSet !== this.set) this.flushCommit();
    clearTimeout(this.commitTimer);
    const set = (this.pendingCommitSet = this.set);
    this.commitTimer = window.setTimeout(() => this.commitLayers('Edit layer', set), 600);
    this.emit('history');
  }

  private flushCommit() {
    if (this.commitTimer && this.pendingCommitSet) this.commitLayers('Edit layer', this.pendingCommitSet);
  }

  private pushHistory(e: HistoryEntry<TextureSet>) {
    if (e.kind === 'pixels') this.flushCommit();
    this.undoStack.push(e);
    const dropped = this.redoStack;
    this.redoStack = [];
    let pixels = 0;
    let bytes = 0;
    for (const x of this.undoStack) {
      if (x.kind === 'pixels') pixels++;
      bytes += pixelEntryBytes(x);
    }
    // The newest step is always kept, even if it alone is over the memory budget.
    while (
      this.undoStack.length > 1 &&
      (this.undoStack.length > HISTORY_LIMIT || pixels > PIXEL_HISTORY_LIMIT || bytes > PIXEL_HISTORY_BYTES)
    ) {
      const d = this.undoStack.shift()!;
      if (d.kind === 'pixels') pixels--;
      bytes -= pixelEntryBytes(d);
      dropped.push(d);
    }
    this.dropEntries(dropped);
    this.emit('history');
  }

  /** Frees what only the dropped entries kept alive: stroke snapshots, and deleted layers / removed masks. */
  private dropEntries(dropped: HistoryEntry<TextureSet>[]) {
    if (!dropped.length) return;
    const candLayers = new Set<Layer>();
    const candMasks = new Set<LayerMask>();
    for (const d of dropped) {
      if (d.kind === 'pixels') d.entry.rt.dispose();
      else {
        treeRefs(d.before, candLayers, candMasks);
        treeRefs(d.after, candLayers, candMasks);
      }
    }
    const liveLayers = new Set<Layer>();
    const liveMasks = new Set<LayerMask>();
    for (const s of this.sets) {
      liveRefs(s.layers, liveLayers, liveMasks);
      treeRefs(s.committed, liveLayers, liveMasks);
    }
    for (const e of [...this.undoStack, ...this.redoStack]) {
      if (e.kind === 'pixels') liveLayers.add(e.entry.layer);
      else {
        treeRefs(e.before, liveLayers, liveMasks);
        treeRefs(e.after, liveLayers, liveMasks);
      }
    }
    for (const l of candLayers) if (!liveLayers.has(l) && l.kind === 'paint') l.rt.dispose();
    for (const m of candMasks) if (!liveMasks.has(m)) m.rt.dispose();
  }

  clearHistory() {
    clearTimeout(this.commitTimer);
    this.commitTimer = 0;
    this.pendingCommitSet = null;
    const dropped = [...this.undoStack, ...this.redoStack];
    this.undoStack = [];
    this.redoStack = [];
    this.dropEntries(dropped);
    this.emit('history');
  }

  /** Makes every set's current layer tree the starting point for undo. */
  private rebaseline() {
    for (const s of this.sets) s.committed = captureTree(s.layers, s.selectedId);
  }

  undo() {
    if (this.painter.isPainting) return;
    this.flushCommit();
    const e = this.undoStack.pop();
    if (!e) return;
    this.applyEntry(e, 'undo');
    this.redoStack.push(e);
    this.emit('history');
  }

  redo() {
    if (this.painter.isPainting) return;
    this.flushCommit();
    const e = this.redoStack.pop();
    if (!e) return;
    this.applyEntry(e, 'redo');
    this.undoStack.push(e);
    this.emit('history');
  }

  private applyEntry(e: HistoryEntry<TextureSet>, dir: 'undo' | 'redo') {
    if (e.kind === 'pixels') swapPixels(e.entry);
    else {
      const st = dir === 'undo' ? e.before : e.after;
      const set = e.owner;
      set.layers = restoreTree(st);
      set.committed = st;
      set.selectedId = st.selectedId;
      const sel = set.selectedId === null ? null : locateLayer(set.layers, set.selectedId)?.layer;
      if (!sel) set.selectedId = set.layers[set.layers.length - 1]?.id ?? null;
      if (set.part === 'mask' && !sel?.mask) set.part = 'content';
      const i = this.sets.indexOf(set);
      if (i >= 0 && i !== this.activeSet) this.activateSet(i);
      this.emit('layers');
      this.emit('selection');
    }
    this.invalidate(true);
  }

  // ---------------------------------------------------------------- project IO
  saveProject(): Uint8Array {
    return zipSync(this.projectFiles(), { level: 6 });
  }

  /** Project contents before zipping (GPU readback happens here; zip can then run in a worker). */
  projectFiles(): Record<string, Uint8Array> {
    if (!this.mesh) throw new Error('Nothing to save.');
    return collectProjectFiles(this.renderer, {
      sets: this.sets.map((s) => ({ name: s.info.name, texSize: s.texSize, layers: s.layers })),
      meshSource: this.mesh.source,
      bake: this.bake,
      highPoly: this.highPoly && { name: this.highPoly.name, bytes: this.highPoly.bytes },
      composite: this.composite,
      brush: this.brush,
      textures: this.usedTextureIds()
        .map((id) => this.textures.asset(id))
        .filter((a): a is NonNullable<typeof a> => !!a),
    });
  }

  async loadProject(bytes: Uint8Array) {
    const p = readProject(bytes);
    await this.beforeReplace?.().catch(() => undefined);
    const psets = projectSets(p.json);
    this.setProgress(true, 'Loading project', 0);
    let mesh: PaintMesh;
    try {
      mesh = await loadMeshSource(p.meshSource);
    } finally {
      this.setProgress(false);
    }
    // Rebuild every layer before touching the open document, so a corrupt file leaves the current work intact.
    const sizes = mesh.sets.map((_, i) => psets[i]?.texSize ?? 2048);
    const stacks: (Layer[] | null)[] = [];
    try {
      for (const [i, size] of sizes.entries()) stacks.push(psets[i] ? restoreLayers(this.renderer, this.copier, p, psets[i].layers, size) : null);
    } catch (e) {
      for (const st of stacks) st?.forEach(disposeLayer);
      mesh.geometry.dispose();
      throw e;
    }
    this.bake = { ...DEFAULT_BAKE, ...p.json.bake };
    this.composite = { ...this.composite, ...p.json.composite };
    // Projects from older versions lack newer brush fields; fill them from the defaults.
    const brush = { ...this.brush, ...p.json.brush };
    this.brush = { ...DEFAULT_BRUSH_EXTRAS, ...brush, maps: brush.maps ?? null, tiling: brush.tiling ?? 4, stencil: { ...DEFAULT_STENCIL, ...brush.stencil } };
    await Promise.all(p.textures.map((t) => this.textures.add(t)));
    this.highPoly?.dispose();
    this.highPoly = null;
    if (p.highPoly) {
      try {
        this.highPoly = await HighPoly.load(p.highPoly.name, p.highPoly.bytes, mesh);
      } catch (e) {
        this.toast(`High-poly mesh could not be loaded: ${(e as Error).message}`, 'warn');
      }
    }
    // openMesh emits 'mesh' last, after its own redraw request: autosave treats the loaded project as unmodified.
    await this.openMesh(mesh, stacks, sizes);
    if (psets.length !== mesh.sets.length) this.toast(`Project has ${psets.length} texture set(s) but the mesh has ${mesh.sets.length}; matched by order.`, 'warn');
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
