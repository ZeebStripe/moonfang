import * as THREE from 'three';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { MaterialPreset, SmartMaterial } from '../data/materials';
import { MAP_KEYS, type MaterialMaps } from './layers';

/** Raw image file used by material maps. Ids are content hashes, so identical images are shared. */
export interface TextureAsset {
  id: string;
  name: string;
  mime: string;
  bytes: Uint8Array;
}

const MAX_TEXTURE = 2048;

// ------------------------------------------------------------------------------------------ texture store

/** Decodes texture assets into repeat-wrapped, mipmapped GPU textures (raw values, no color conversion). */
export class TextureStore {
  private assets = new Map<string, TextureAsset>();
  private textures = new Map<string, THREE.Texture>();
  private listeners = new Set<() => void>();

  onLoad(fn: () => void) {
    this.listeners.add(fn);
  }

  asset(id: string) {
    return this.assets.get(id);
  }

  /** null until the image has been decoded */
  get(id: string | undefined): THREE.Texture | null {
    return id ? (this.textures.get(id) ?? null) : null;
  }

  ready(maps: MaterialMaps | null | undefined): boolean {
    return !maps || MAP_KEYS.every((k) => !maps[k] || this.textures.has(maps[k]!));
  }

  add(asset: TextureAsset): Promise<void> {
    if (this.assets.has(asset.id)) return Promise.resolve();
    this.assets.set(asset.id, asset);
    return this.decode(asset).catch((e) => {
      console.warn(`Could not decode texture ${asset.name}`, e);
    });
  }

  private async decode(a: TextureAsset) {
    const blob = new Blob([a.bytes as BlobPart], { type: a.mime });
    const opts: ImageBitmapOptions = { premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
    let bmp = await createImageBitmap(blob, opts);
    const big = Math.max(bmp.width, bmp.height);
    if (big > MAX_TEXTURE) {
      const s = MAX_TEXTURE / big;
      const w = Math.round(bmp.width * s);
      const h = Math.round(bmp.height * s);
      bmp.close();
      bmp = await createImageBitmap(blob, { ...opts, resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
    }
    const t = new THREE.Texture(bmp);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.NoColorSpace;
    t.flipY = false;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = 8;
    t.needsUpdate = true;
    t.name = a.name;
    this.textures.set(a.id, t);
    for (const fn of this.listeners) fn();
  }

  remove(id: string) {
    this.textures.get(id)?.dispose();
    this.textures.delete(id);
    this.assets.delete(id);
  }
}

export async function makeAsset(name: string, bytes: Uint8Array, mime?: string): Promise<TextureAsset> {
  const digest = await crypto.subtle.digest('SHA-1', bytes as BufferSource);
  const id = Array.from(new Uint8Array(digest).slice(0, 10), (b) => b.toString(16).padStart(2, '0')).join('');
  return { id, name, mime: mime || mimeFromName(name), bytes };
}

function mimeFromName(name: string) {
  const ext = name.split('.').pop()!.toLowerCase();
  return ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'avif' ? 'image/avif' : 'image/jpeg';
}

export function mapTextureIds(maps: MaterialMaps | null | undefined): string[] {
  if (!maps) return [];
  return [...new Set(MAP_KEYS.map((k) => maps[k]).filter((x): x is string => !!x))];
}

// ------------------------------------------------------------------------------------------ shader uniforms

export function mapUniforms(): Record<string, THREE.IUniform> {
  return {
    uMapC: { value: null },
    uMapR: { value: null },
    uMapM: { value: null },
    uMapH: { value: null },
    uMapN: { value: null },
    uMeshC: { value: null },
    uMapNrm: { value: new THREE.Vector3() },
    uMapOn: { value: new THREE.Vector4() },
    uMapLod: { value: new THREE.Vector4() },
    uMapChan: { value: new THREE.Vector4() },
    uMapParams: { value: new THREE.Vector2(1, 0) },
  };
}

const dummyTex = (() => {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
})();

/**
 * Binds a material's maps for GLSL_MAPS. `outSize` is the paint texture resolution; the mip level is picked so
 * one output texel covers roughly one map texel (the model spans ~half the UV space).
 */
export function setMapUniforms(
  u: Record<string, THREE.IUniform>,
  maps: MaterialMaps | null | undefined,
  tiling: number,
  store: TextureStore,
  outSize: number,
) {
  const slots = [
    ['uMapC', maps?.color],
    ['uMapR', maps?.roughness],
    ['uMapM', maps?.metallic],
    ['uMapH', maps?.height],
  ] as const;
  const on = [0, 0, 0, 0];
  const lod = [0, 0, 0, 0];
  slots.forEach(([name, id], i) => {
    const t = store.get(id);
    u[name].value = t ?? dummyTex;
    if (!t) return;
    on[i] = 1;
    const img = t.image as { width: number; height: number };
    lod[i] = Math.max(0, Math.log2((Math.max(img.width, img.height) * tiling) / (outSize * 0.5)));
  });
  u.uMapOn.value.set(on[0], on[1], on[2], on[3]);
  u.uMapLod.value.set(lod[0], lod[1], lod[2], lod[3]);
  const ch = maps?.channels ?? {};
  u.uMapChan.value.set(0, ch.roughness ?? 0, ch.metallic ?? 0, ch.height ?? 0);
  u.uMapParams.value.set(tiling, maps?.gloss ? 1 : 0);
  const nt = store.get(maps?.normal);
  u.uMapN.value = nt ?? dummyTex;
  const nimg = nt?.image as { width: number; height: number } | undefined;
  const nlod = nimg ? Math.max(0, Math.log2((Math.max(nimg.width, nimg.height) * tiling) / (outSize * 0.5))) : 0;
  u.uMapNrm.value.set(nt ? 1 : 0, maps?.normalDX ? 1 : 0, nlod);
}

// ------------------------------------------------------------------------------------------ texture sets

type Slot = 'color' | 'roughness' | 'gloss' | 'metallic' | 'height' | 'arm' | 'normal' | 'ao' | 'other';

const SLOT_TOKENS: [Slot, string[]][] = [
  ['arm', ['arm', 'orm', 'occlusionroughnessmetallic', 'aorm']],
  ['color', ['basecolor', 'albedo', 'diffuse', 'diff', 'color', 'colour', 'col', 'base']],
  ['gloss', ['gloss', 'glossiness', 'smoothness']],
  ['roughness', ['roughness', 'rough', 'rgh']],
  ['metallic', ['metallic', 'metalness', 'metal', 'mtl']],
  ['height', ['height', 'displacement', 'disp', 'bump', 'heightmap']],
  ['normal', ['normal', 'normalgl', 'normaldx', 'nrm', 'nor', 'norm']],
  ['ao', ['ao', 'occlusion', 'ambientocclusion', 'cavity']],
];

export function classifyTextureName(name: string): Slot {
  const tokens = name
    .replace(/\.[^.]+$/, '')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  // Later tokens win ("Metal_Plate_basecolor" is a color map, not metallic).
  for (let i = tokens.length - 1; i >= 0; i--) {
    for (const [slot, words] of SLOT_TOKENS) if (words.includes(tokens[i])) return slot;
  }
  const joined = tokens.join('');
  for (const [slot, words] of SLOT_TOKENS) if (words.some((w) => w.length > 3 && joined.endsWith(w))) return slot;
  return 'other';
}

export interface TextureSetResult {
  material: MaterialPreset;
  assets: TextureAsset[];
  skipped: string[];
}

/** Builds a material from loose PBR image files (BaseColor / Roughness / Metallic / Height / ARM …). */
export async function importTextureSet(files: { name: string; bytes: Uint8Array }[]): Promise<TextureSetResult> {
  const maps: MaterialMaps = {};
  const assets: TextureAsset[] = [];
  const skipped: string[] = [];
  const channels: Record<string, number> = {};
  for (const f of files) {
    const slot = classifyTextureName(f.name);
    if (slot === 'ao' || slot === 'other') {
      skipped.push(`${f.name} (${slot === 'other' ? 'unrecognised' : 'AO comes from the mesh bake'})`);
      continue;
    }
    const asset = await makeAsset(f.name, f.bytes);
    assets.push(asset);
    if (slot === 'arm') {
      if (!maps.roughness) {
        maps.roughness = asset.id;
        channels.roughness = 1;
      }
      if (!maps.metallic) {
        maps.metallic = asset.id;
        channels.metallic = 2;
      }
    } else if (slot === 'normal') {
      // Poly Haven names them *_nor_gl / *_nor_dx; others use "NormalDX" / "Normal_DirectX".
      if (maps.normal && !/(^|[^a-z])(gl|opengl)([^a-z]|$)/i.test(f.name)) continue;
      maps.normal = asset.id;
      maps.normalDX = /normaldx|(^|[^a-z])(dx|directx)([^a-z]|$)/i.test(f.name.replace(/\.[^.]+$/, ''));
    } else if (slot === 'gloss') {
      maps.roughness = asset.id;
      maps.gloss = true;
      channels.roughness = 0;
    } else {
      maps[slot] = asset.id;
      channels[slot] = 0;
    }
  }
  if (!assets.length) throw new Error('No usable maps found. Name files like *_BaseColor, *_Roughness, *_Metallic, *_Height.');
  const name = commonName(files.map((f) => f.name));
  const material: MaterialPreset = {
    id: `user_${assets[0].id}`,
    name,
    category: 'Custom',
    values: { color: [1, 1, 1], roughness: 0.5, metallic: 0, height: 0.5 },
    maps: { ...maps, channels: { roughness: channels.roughness ?? 0, metallic: channels.metallic ?? 0, height: 0 } },
    tiling: 4,
    custom: true,
  };
  return { material, assets, skipped };
}

function commonName(names: string[]): string {
  const stems = names.map((n) => n.replace(/\.[^.]+$/, ''));
  let prefix = stems[0];
  for (const s of stems) while (!s.startsWith(prefix)) prefix = prefix.slice(0, -1);
  prefix = prefix.replace(/[\s_\-.]+$/, '').replace(/[_\-]+/g, ' ').trim();
  return prefix || stems[0].replace(/[_\-]+/g, ' ');
}

// ------------------------------------------------------------------------------------------ library

const LIB_FORMAT = 'moonfang-library';

interface LibraryJson {
  format: typeof LIB_FORMAT;
  version: 1;
  materials: MaterialPreset[];
  smartMaterials: SmartMaterial[];
  tips?: { id: string; name: string; assetId: string }[];
  textures?: { id: string; name: string; mime: string; path: string }[];
}

/** User materials + smart materials, persisted in IndexedDB together with their texture images. */
export class Library {
  materials: MaterialPreset[] = [];
  smart: SmartMaterial[] = [];
  /** imported brush tips (normalised greyscale PNG assets) */
  tips: { id: string; name: string; assetId: string }[] = [];
  private listeners = new Set<() => void>();
  /** Saves run one after another: an older save would otherwise delete images a newer one just stored. */
  private saving: Promise<void> = Promise.resolve();

  constructor(private store: TextureStore) {}

  onChange(fn: () => void) {
    this.listeners.add(fn);
  }
  private changed() {
    for (const fn of this.listeners) fn();
    this.saving = this.saving.then(() => this.persist());
  }

  async load() {
    try {
      const data = (await idbGet('library')) as Pick<LibraryJson, 'materials' | 'smartMaterials' | 'tips'> | undefined;
      if (!data) return;
      this.materials = data.materials ?? [];
      this.smart = data.smartMaterials ?? [];
      this.tips = data.tips ?? [];
      for (const id of this.textureIds()) {
        const a = (await idbGet(`tex:${id}`)) as TextureAsset | undefined;
        if (a) void this.store.add(a);
      }
      for (const fn of this.listeners) fn();
    } catch (e) {
      console.warn('Could not load material library', e);
    }
  }

  private textureIds(): Set<string> {
    const ids = new Set<string>();
    for (const m of this.materials) mapTextureIds(m.maps).forEach((id) => ids.add(id));
    for (const s of this.smart) for (const l of s.layers) mapTextureIds(l.maps).forEach((id) => ids.add(id));
    for (const t of this.tips) ids.add(t.assetId);
    return ids;
  }

  private async persist() {
    try {
      const ids = this.textureIds();
      for (const id of ids) {
        const a = this.store.asset(id);
        if (a && !(await idbHas(`tex:${id}`))) await idbPut(`tex:${id}`, a);
      }
      for (const key of await idbKeys()) {
        if (key.startsWith('tex:') && !ids.has(key.slice(4))) await idbDel(key);
      }
      await idbPut('library', { materials: this.materials, smartMaterials: this.smart, tips: this.tips });
    } catch (e) {
      console.warn('Could not save material library', e);
    }
  }

  addMaterial(m: MaterialPreset) {
    this.materials = [...this.materials.filter((x) => x.id !== m.id), { ...m, custom: true }];
    this.changed();
  }

  addSmart(s: SmartMaterial) {
    this.smart = [...this.smart.filter((x) => x.id !== s.id), { ...s, custom: true }];
    this.changed();
  }

  addTip(tip: { id: string; name: string; assetId: string }) {
    this.tips = [...this.tips.filter((t) => t.id !== tip.id), tip];
    this.changed();
  }

  remove(id: string) {
    this.materials = this.materials.filter((m) => m.id !== id);
    this.smart = this.smart.filter((s) => s.id !== id);
    this.tips = this.tips.filter((t) => t.id !== id);
    this.changed();
  }

  /** Exports the whole user library (or a subset) as a zip with images. */
  exportFile(materials = this.materials, smart = this.smart): Uint8Array {
    const files: Record<string, Uint8Array> = {};
    const textures: NonNullable<LibraryJson['textures']> = [];
    const ids = new Set<string>();
    for (const m of materials) mapTextureIds(m.maps).forEach((i) => ids.add(i));
    for (const s of smart) for (const l of s.layers) mapTextureIds(l.maps).forEach((i) => ids.add(i));
    for (const id of ids) {
      const a = this.store.asset(id);
      if (!a) continue;
      const path = `textures/${id}_${a.name.replace(/[^\w.\-]+/g, '_')}`;
      files[path] = a.bytes;
      textures.push({ id, name: a.name, mime: a.mime, path });
    }
    const json: LibraryJson = { format: LIB_FORMAT, version: 1, materials, smartMaterials: smart, textures };
    files['library.json'] = strToU8(JSON.stringify(json, null, 1));
    return zipSync(files, { level: 0 });
  }

  /** Imports a .mflib/.zip (with textures) or a plain library .json. Returns counts. */
  async importFile(name: string, bytes: Uint8Array): Promise<{ materials: number; smart: number }> {
    let json: LibraryJson;
    let files: Record<string, Uint8Array> = {};
    if (/\.json$/i.test(name)) json = JSON.parse(strFromU8(bytes));
    else {
      files = unzipSync(bytes);
      if (!files['library.json']) throw new Error('library.json missing — not a Moonfang library.');
      json = JSON.parse(strFromU8(files['library.json']));
    }
    if (json.format !== LIB_FORMAT) throw new Error('Not a Moonfang material library.');
    for (const t of json.textures ?? []) {
      const data = files[t.path];
      if (data) await this.store.add({ id: t.id, name: t.name, mime: t.mime, bytes: data });
    }
    const mats = (json.materials ?? []).map((m) => ({ ...m, category: 'Custom' as const, custom: true }));
    const smart = (json.smartMaterials ?? []).map((s) => ({ ...s, custom: true }));
    const mIds = new Set(mats.map((m) => m.id));
    const sIds = new Set(smart.map((s) => s.id));
    this.materials = [...this.materials.filter((m) => !mIds.has(m.id)), ...mats];
    this.smart = [...this.smart.filter((s) => !sIds.has(s.id)), ...smart];
    this.changed();
    return { materials: mats.length, smart: smart.length };
  }
}

// ------------------------------------------------------------------------------------------ IndexedDB

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('moonfang', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(d.transaction('kv', mode).objectStore('kv'));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}
const idbGet = (k: string) => tx('readonly', (s) => s.get(k));
const idbPut = (k: string, v: unknown) => tx('readwrite', (s) => s.put(v, k));
const idbDel = (k: string) => tx('readwrite', (s) => s.delete(k));
const idbKeys = () => tx('readonly', (s) => s.getAllKeys()).then((ks) => ks.map(String));
const idbHas = (k: string) => tx('readonly', (s) => s.count(k)).then((n) => n > 0);

/** Small key/value access to the app's IndexedDB store (used by autosave). */
export const kv = { get: idbGet, put: idbPut, del: idbDel };
