import { unzipSync } from 'fflate';
import type { App } from '../app';
import { packGltf } from '../engine/gltfPack';
import { loadMeshFile } from '../engine/meshLoader';
import { errorMessage, openModal } from './actions';
import { h, pickFiles } from './dom';

/**
 * Model files from any source (file picker, drag & drop of files or folders, a .zip) as one flat set of
 * relative paths, so a .gltf can find its .bin no matter how the user brought it in.
 */
export interface VFile {
  /** relative path with '/' separators, e.g. "car/scene.bin" */
  path: string;
  read(): Promise<Uint8Array>;
}

/** What Open Mesh lets the user pick: models plus the files a .gltf may need, or a .zip of them. */
export const MODEL_ACCEPT = '.glb,.gltf,.obj,.fbx,.bin,.zip,.png,.jpg,.jpeg,.webp,.ktx2';
const MODEL_EXTS = ['gltf', 'glb', 'fbx', 'obj'];
/** Texture images: never needed (Moonfang drops a model's own textures), so zips don't even extract them. */
const IMAGE_RE = /\.(png|jpe?g|webp|ktx2|basis|dds|tga|bmp|gif|avif)$/i;

const ext = (path: string) => path.split('.').pop()!.toLowerCase();
const baseName = (path: string) => path.split('/').pop()!;

export function fromFiles(files: File[]): VFile[] {
  return files.map((f) => ({ path: (f.webkitRelativePath || f.name).replace(/\\/g, '/'), read: async () => new Uint8Array(await f.arrayBuffer()) }));
}

/** Dropped files and folders (folders are walked recursively). Entries must be taken from the drop event synchronously. */
export async function fromDropEntries(entries: FileSystemEntry[]): Promise<VFile[]> {
  const out: VFile[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ path: entry.fullPath.replace(/^\/+/, ''), read: async () => new Uint8Array(await file.arrayBuffer()) });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns the folder in batches; an empty batch means done.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

/** File names inside a zip, without extracting anything. */
function zipNames(bytes: Uint8Array): string[] {
  const names: string[] = [];
  unzipSync(bytes, { filter: (f) => (names.push(f.name), false) });
  return names;
}

/** A dropped/opened .zip is a Moonfang project, a material library, or a zipped model. */
export function zipKind(bytes: Uint8Array): 'project' | 'library' | 'model' {
  const names = zipNames(bytes);
  if (names.includes('project.json')) return 'project';
  if (names.includes('library.json')) return 'library';
  return 'model';
}

/** Replaces .zip files in the set by their contents (paths prefixed with the zip's folder). */
async function expandZips(files: VFile[]): Promise<VFile[]> {
  const out: VFile[] = [];
  for (const f of files) {
    if (ext(f.path) !== 'zip') {
      out.push(f);
      continue;
    }
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
    const entries = unzipSync(await f.read(), { filter: (z) => !z.name.endsWith('/') && !IMAGE_RE.test(z.name) });
    for (const [name, data] of Object.entries(entries)) out.push({ path: dir + name, read: async () => data });
  }
  return out;
}

/** The model to open: .gltf before .glb before .fbx before .obj; the shallowest path wins within a kind. */
function pickModel(files: VFile[]): { model: VFile; others: number } | null {
  const models = files.filter((f) => MODEL_EXTS.includes(ext(f.path)) && !baseName(f.path).startsWith('._'));
  if (!models.length) return null;
  models.sort(
    (a, b) =>
      MODEL_EXTS.indexOf(ext(a.path)) - MODEL_EXTS.indexOf(ext(b.path)) ||
      a.path.split('/').length - b.path.split('/').length ||
      a.path.localeCompare(b.path),
  );
  return { model: models[0], others: models.length - 1 };
}

/** Finds a referenced file by its exact relative path, else by file name alone (when it is unambiguous). */
function makeLookup(files: VFile[]) {
  const byPath = new Map(files.map((f) => [f.path.toLowerCase(), f]));
  const byName = new Map<string, VFile[]>();
  for (const f of files) {
    const k = baseName(f.path).toLowerCase();
    byName.set(k, [...(byName.get(k) ?? []), f]);
  }
  return async (path: string) => {
    const hit = byPath.get(path.toLowerCase()) ?? (byName.get(baseName(path).toLowerCase())?.length === 1 ? byName.get(baseName(path).toLowerCase())![0] : undefined);
    return hit?.read();
  };
}

/** Lists what a .gltf still needs and lets the user add it. Resolves with the added files, or null when cancelled. */
function askForMissing(model: string, missing: string[]): Promise<VFile[] | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: VFile[] | null) => {
      if (done) return;
      done = true;
      close();
      resolve(v);
    };
    const add = h('button', { class: 'btn primary' }, 'Add files…');
    const cancel = h('button', { class: 'btn' }, 'Cancel');
    const close = openModal(
      'Some model files are missing',
      h(
        'div',
        { class: 'form' },
        h('p', {}, `${baseName(model)} keeps its geometry in separate files. These weren't found:`),
        h('ul', { class: 'missing-files' }, ...missing.map((m) => h('li', {}, h('code', {}, m)))),
        h(
          'p',
          { class: 'dim small' },
          'Add them (or the whole model folder as a .zip), or drop the .gltf together with its files or its folder. Texture images are never needed. Alternatively, export the model as .glb (in Blender: File → Export → glTF 2.0, format "glTF Binary").',
        ),
      ),
      [cancel, add],
      () => finish(null),
    );
    cancel.addEventListener('click', () => finish(null));
    add.addEventListener('click', async () => {
      const picked = await pickFiles('', true);
      if (picked.length) finish(fromFiles(picked));
    });
  });
}

/**
 * Turns a set of files into one loadable model file: a .gltf is packed with its buffers into a .glb (asking for
 * missing files); other formats pass through. Resolves null when the user cancels.
 */
export async function resolveModel(app: App, files: VFile[]): Promise<{ name: string; bytes: Uint8Array } | null> {
  let set = await expandZips(files);
  const found = pickModel(set);
  if (!found) throw new Error('No model found. Moonfang opens .glb, .gltf, .fbx and .obj files (also inside a folder or .zip).');
  const { model, others } = found;
  if (others) app.toast(`Found ${others + 1} models; opening ${baseName(model.path)}.`, 'warn');
  if (ext(model.path) !== 'gltf') return { name: baseName(model.path), bytes: await model.read() };
  const gltf = await model.read();
  for (;;) {
    const res = await packGltf(model.path, gltf, makeLookup(set));
    if (res.bytes) return { name: baseName(model.path).replace(/\.gltf$/i, '.glb'), bytes: res.bytes };
    const added = await askForMissing(model.path, res.missing);
    if (!added) return null;
    set = [...set, ...(await expandZips(added))];
  }
}

/** Open Mesh / drop: resolve the files to one model and load it. */
export async function openModelFiles(app: App, files: VFile[]) {
  if (app.busy) return;
  try {
    const model = await resolveModel(app, files);
    if (!model) return;
    const mesh = await loadMeshFile(model.name, model.bytes.slice().buffer);
    const keep = app.mesh && app.allLayers.length > 2 && confirm('Keep the current layers on the new mesh? (Cancel starts a fresh layer stack)');
    await app.openMesh(mesh, keep ? 'keep' : 'reset');
    app.toast(`Loaded ${model.name}`);
  } catch (e) {
    app.toast(`Could not load mesh: ${errorMessage(e)}`, 'error');
  }
}
