import * as THREE from 'three';
import { strToU8, strFromU8, unzipSync, zipSync } from 'fflate';
import { Copier, readRGBA8 } from './gl';
import {
  bumpLayerId,
  createMaskRT,
  createPaintRT,
  type FillLayer,
  type GroupLayer,
  type Layer,
  type LayerMask,
  type PaintLayer,
} from './layers';
import type { MeshSource } from './meshLoader';
import type { TextureAsset } from './library';
import type { BakeSettings } from './meshMaps';
import type { CompositeSettings } from './compositor';
import type { BrushSettings } from './painter';

const FORMAT = 'open-painter-project';
const VERSION = 1;

type SerializedMask = Omit<LayerMask, 'rt'> & { data: string };
type SerializedLayer =
  | (Omit<PaintLayer, 'rt' | 'mask'> & { mask: SerializedMask | null; data: string[] })
  | (Omit<FillLayer, 'mask'> & { mask: SerializedMask | null })
  | (Omit<GroupLayer, 'mask' | 'children'> & { mask: SerializedMask | null; children: SerializedLayer[] });

interface ProjectJson {
  format: typeof FORMAT;
  version: number;
  texSize: number;
  mesh: { kind: 'demo'; id: string } | { kind: 'file'; name: string; path: string };
  bake: BakeSettings;
  composite: CompositeSettings;
  brush: BrushSettings;
  layers: SerializedLayer[];
  textures?: { id: string; name: string; mime: string; path: string }[];
}

export interface ProjectState {
  texSize: number;
  meshSource: MeshSource;
  bake: BakeSettings;
  composite: CompositeSettings;
  brush: BrushSettings;
  layers: Layer[];
  /** images referenced by textured fill layers / the brush */
  textures: TextureAsset[];
}

export function saveProject(renderer: THREE.WebGLRenderer, s: ProjectState): Uint8Array {
  return zipSync(collectProjectFiles(renderer, s), { level: 6 });
}

/** Reads every layer back from the GPU and returns the project's files (zip them to get an .opp). */
export function collectProjectFiles(renderer: THREE.WebGLRenderer, s: ProjectState): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const serialize = (l: Layer): SerializedLayer => {
    let mask: SerializedMask | null = null;
    if (l.mask) {
      const path = `layers/${l.id}_mask.bin`;
      files[path] = readRGBA8(renderer, l.mask.rt);
      mask = { enabled: l.mask.enabled, generator: l.mask.generator, data: path };
    }
    if (l.kind === 'paint') {
      const { rt, mask: _m, ...rest } = l;
      const data = rt.textures.map((_, i) => {
        const path = `layers/${l.id}_c${i}.bin`;
        files[path] = readRGBA8(renderer, rt, i);
        return path;
      });
      return { ...rest, mask, data };
    }
    if (l.kind === 'group') {
      const { mask: _m, children, ...rest } = l;
      return { ...rest, mask, children: children.map(serialize) };
    }
    const { mask: _m, ...rest } = l;
    return { ...rest, mask };
  };
  const layers = s.layers.map(serialize);
  let mesh: ProjectJson['mesh'];
  if (s.meshSource.kind === 'demo') mesh = { kind: 'demo', id: s.meshSource.id };
  else {
    const path = `mesh/${s.meshSource.name}`;
    files[path] = new Uint8Array(s.meshSource.bytes);
    mesh = { kind: 'file', name: s.meshSource.name, path };
  }
  const textures = s.textures.map((t) => {
    const path = `textures/${t.id}`;
    files[path] = t.bytes;
    return { id: t.id, name: t.name, mime: t.mime, path };
  });
  const json: ProjectJson = { format: FORMAT, version: VERSION, texSize: s.texSize, mesh, bake: s.bake, composite: s.composite, brush: s.brush, layers, textures };
  files['project.json'] = strToU8(JSON.stringify(json, null, 1));
  renderer.setRenderTarget(null);
  return files;
}

export interface LoadedProject {
  json: ProjectJson;
  meshSource: MeshSource;
  files: Record<string, Uint8Array>;
  textures: TextureAsset[];
}

export function readProject(bytes: Uint8Array): LoadedProject {
  const files = unzipSync(bytes);
  if (!files['project.json']) throw new Error('Not an Open Painter project (project.json missing).');
  const json = JSON.parse(strFromU8(files['project.json'])) as ProjectJson;
  if (json.format !== FORMAT) throw new Error('Not an Open Painter project.');
  if (json.version > VERSION) throw new Error(`Project was saved by a newer version (format ${json.version}).`);
  let meshSource: MeshSource;
  if (json.mesh.kind === 'demo') meshSource = { kind: 'demo', id: json.mesh.id as never };
  else {
    const data = files[json.mesh.path];
    if (!data) throw new Error('Mesh file missing from project.');
    meshSource = { kind: 'file', name: json.mesh.name, bytes: data.slice().buffer };
  }
  const textures = (json.textures ?? [])
    .filter((t) => files[t.path])
    .map((t) => ({ id: t.id, name: t.name, mime: t.mime, bytes: files[t.path] }));
  return { json, meshSource, files, textures };
}

/** Recreates GPU layers; must be called after the texture size is set. */
export function restoreLayers(renderer: THREE.WebGLRenderer, copier: Copier, p: LoadedProject): Layer[] {
  const size = p.json.texSize;
  const upload = (path: string) => {
    const data = p.files[path];
    if (!data || data.length !== size * size * 4) throw new Error(`Corrupt layer data: ${path}`);
    const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.flipY = false;
    t.needsUpdate = true;
    return t;
  };
  const restore = (s: SerializedLayer): Layer => {
    let mask: LayerMask | null = null;
    if (s.mask) {
      const rt = createMaskRT(renderer, size, 1);
      const t = upload(s.mask.data);
      copier.copy(renderer, [t], rt);
      t.dispose();
      mask = { rt, enabled: s.mask.enabled, generator: s.mask.generator };
    }
    bumpLayerId(s.id);
    if (s.kind === 'paint') {
      const rt = createPaintRT(size);
      const tex = s.data.map(upload);
      // Projects saved before the normal channel have three paint targets; the fourth starts empty.
      while (tex.length < rt.textures.length) {
        const t = new THREE.DataTexture(new Uint8Array(size * size * 4), size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
        t.needsUpdate = true;
        tex.push(t);
      }
      copier.copy(renderer, tex, rt);
      tex.forEach((t) => t.dispose());
      const { data: _d, mask: _m, ...rest } = s;
      return { ...rest, mask, rt };
    }
    if (s.kind === 'group') {
      const { mask: _m, children, ...rest } = s;
      return { ...rest, mask, children: children.map(restore) };
    }
    const { mask: _m, ...rest } = s;
    return { ...rest, maps: rest.maps ?? null, tiling: rest.tiling ?? 4, mask };
  };
  const layers = p.json.layers.map(restore);
  renderer.setRenderTarget(null);
  return layers;
}
