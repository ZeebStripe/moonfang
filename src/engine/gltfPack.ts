/**
 * Packs a .gltf and the files it references into one self-contained .glb, so the rest of the app (loading,
 * projects, autosaves, versions) only ever deals with a single mesh file.
 *
 * Moonfang only uses a model's geometry, UVs and material groups, never its textures, so images are dropped rather
 * than embedded: users don't have to supply them, and projects don't carry megabytes of unused pixels. Buffers
 * (.bin files) are required.
 */

export type FileLookup = (path: string) => Promise<Uint8Array | undefined>;

export interface PackResult {
  /** the .glb, or null when required files are missing */
  bytes: Uint8Array | null;
  /** referenced files that couldn't be found (paths relative to the .gltf's folder) */
  missing: string[];
  /** number of texture images left out */
  droppedImages: number;
}

/** Extensions that only describe textures; they go away together with the images. */
const TEXTURE_EXTENSIONS = new Set(['KHR_texture_basisu', 'EXT_texture_webp', 'EXT_texture_avif', 'KHR_texture_transform', 'MSFT_texture_dds']);

/** Resolves a URI from a .gltf against the .gltf's own path ("models/car.gltf" + "car.bin" → "models/car.bin"). */
export function resolveUri(gltfPath: string, uri: string): string {
  const dir = gltfPath.includes('/') ? gltfPath.slice(0, gltfPath.lastIndexOf('/') + 1) : '';
  let rel = uri;
  try {
    rel = decodeURIComponent(uri);
  } catch {
    // keep the raw URI
  }
  const out: string[] = [];
  for (const part of (dir + rel).replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function decodeDataUri(uri: string): Uint8Array {
  const comma = uri.indexOf(',');
  const meta = uri.slice(5, comma);
  const data = uri.slice(comma + 1);
  if (meta.endsWith(';base64')) {
    const bin = atob(data);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new TextEncoder().encode(decodeURIComponent(data));
}

type Json = Record<string, unknown>;

/** Removes every texture reference ("baseColorTexture", "normalTexture", extension textures …) from materials. */
function stripTextureRefs(node: unknown) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach(stripTextureRefs);
  const obj = node as Json;
  for (const [k, v] of Object.entries(obj)) {
    if (/Texture$/.test(k) && v && typeof v === 'object' && 'index' in (v as Json)) delete obj[k];
    else stripTextureRefs(v);
  }
}

const align4 = (n: number) => (n + 3) & ~3;

/** The .gltf names the files it needs (buffers) and the images it would like. */
export function gltfReferences(gltfPath: string, json: Json): { buffers: string[]; images: string[] } {
  const ext = (list: unknown) => ((list as { uri?: string }[] | undefined) ?? []).map((x) => x.uri).filter((u): u is string => !!u && !u.startsWith('data:'));
  return { buffers: ext(json.buffers).map((u) => resolveUri(gltfPath, u)), images: ext(json.images).map((u) => resolveUri(gltfPath, u)) };
}

export async function packGltf(gltfPath: string, gltfBytes: Uint8Array, lookup: FileLookup): Promise<PackResult> {
  let json: Json;
  try {
    json = JSON.parse(new TextDecoder().decode(gltfBytes)) as Json;
  } catch {
    throw new Error('The .gltf file is not valid JSON.');
  }
  const buffers = (json.buffers as { uri?: string; byteLength: number }[] | undefined) ?? [];
  const datas: Uint8Array[] = [];
  const missing: string[] = [];
  for (const b of buffers) {
    if (!b.uri) throw new Error('The .gltf has a buffer without a file name.');
    if (b.uri.startsWith('data:')) {
      datas.push(decodeDataUri(b.uri));
      continue;
    }
    const path = resolveUri(gltfPath, b.uri);
    const data = await lookup(path);
    if (!data) missing.push(path);
    else if (data.length < b.byteLength) throw new Error(`${path} is smaller than the model expects; it may be damaged or belong to another model.`);
    else datas.push(data.subarray(0, b.byteLength));
  }
  const droppedImages = ((json.images as unknown[] | undefined) ?? []).length;
  if (missing.length) return { bytes: null, missing, droppedImages };

  // One binary chunk: all buffers back to back (4-byte aligned), buffer views re-pointed at it.
  const offsets: number[] = [];
  let total = 0;
  for (const d of datas) {
    offsets.push(total);
    total = align4(total + d.length);
  }
  const bin = new Uint8Array(total);
  datas.forEach((d, i) => bin.set(d, offsets[i]));
  for (const bv of (json.bufferViews as Json[] | undefined) ?? []) {
    bv.byteOffset = ((bv.byteOffset as number | undefined) ?? 0) + offsets[bv.buffer as number];
    bv.buffer = 0;
    const meshopt = (bv.extensions as Json | undefined)?.EXT_meshopt_compression as Json | undefined;
    if (meshopt) {
      meshopt.byteOffset = ((meshopt.byteOffset as number | undefined) ?? 0) + offsets[meshopt.buffer as number];
      meshopt.buffer = 0;
    }
  }
  json.buffers = total ? [{ byteLength: total }] : [];

  delete json.images;
  delete json.textures;
  delete json.samplers;
  stripTextureRefs(json.materials);
  for (const key of ['extensionsUsed', 'extensionsRequired'] as const) {
    const list = json[key] as string[] | undefined;
    if (!list) continue;
    const kept = list.filter((e) => !TEXTURE_EXTENSIONS.has(e));
    if (kept.length) json[key] = kept;
    else delete json[key];
  }

  return { bytes: buildGlb(json, bin), missing: [], droppedImages };
}

/** GLB container: 12-byte header, JSON chunk (space padded), optional BIN chunk (zero padded). */
function buildGlb(json: Json, bin: Uint8Array): Uint8Array {
  const raw = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = align4(raw.length);
  const binLen = align4(bin.length);
  const length = 12 + 8 + jsonLen + (binLen ? 8 + binLen : 0);
  const out = new Uint8Array(length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, length, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(raw, 20);
  out.fill(0x20, 20 + raw.length, 20 + jsonLen);
  if (binLen) {
    const o = 20 + jsonLen;
    dv.setUint32(o, binLen, true);
    dv.setUint32(o + 4, 0x004e4942, true); // "BIN\0"
    out.set(bin, o + 8);
  }
  return out;
}
