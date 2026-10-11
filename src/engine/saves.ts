import { kv } from './library';

/**
 * Project snapshots kept in IndexedDB: rolling autosaves (the newest few) and numbered versions the user saves on
 * purpose (iterative saves). A small index record lists them; each project's bytes live under their own key, so the
 * list can be shown without loading every project.
 */
export type SaveKind = 'auto' | 'version';

export interface SaveMeta {
  id: string;
  kind: SaveKind;
  /** ms since epoch */
  time: number;
  /** mesh / project name */
  name: string;
  /** version number per project name (versions only) */
  number?: number;
  /** optional note the user typed (versions only) */
  note?: string;
  /** compressed project size in bytes */
  size: number;
}

/** How many autosaves are kept; older ones are deleted. */
export const AUTOSAVE_KEEP = 5;

const INDEX = 'saves:index';
const DISMISSED = 'saves:dismissed';
const bytesKey = (id: string) => `save:${id}`;

// Index updates run one after another, so concurrent saves can't drop each other's entries: within this window
// through a queue, and across windows / tabs on the same storage through a Web Lock.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const locked = (): Promise<T> => (navigator.locks ? navigator.locks.request('moonfang-saves', fn) : fn());
  const run = queue.then(locked, locked);
  queue = run.catch(() => undefined);
  return run;
}

async function readIndex(): Promise<SaveMeta[]> {
  const index = ((await kv.get(INDEX)) as SaveMeta[] | undefined) ?? [];
  // The single autosave slot of earlier builds becomes the first entry of the history.
  const legacy = (await kv.get('autosave')) as { time: number; name: string; bytes: Uint8Array } | undefined;
  if (legacy?.bytes?.length) {
    const meta: SaveMeta = { id: newId(legacy.time), kind: 'auto', time: legacy.time, name: legacy.name, size: legacy.bytes.length };
    await kv.put(bytesKey(meta.id), legacy.bytes);
    index.push(meta);
    await kv.put(INDEX, index);
    await kv.del('autosave');
  }
  return index;
}

function newId(time = Date.now()) {
  return `${time.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Every save, newest first. */
export function listSaves(): Promise<SaveMeta[]> {
  return serial(async () => (await readIndex()).sort((a, b) => b.time - a.time));
}

export async function readSave(id: string): Promise<Uint8Array | undefined> {
  return (await kv.get(bytesKey(id))) as Uint8Array | undefined;
}

/** Stores a snapshot. Versions get the next number for their project name; autosaves beyond AUTOSAVE_KEEP are pruned. */
export function addSave(kind: SaveKind, name: string, bytes: Uint8Array, note?: string): Promise<SaveMeta> {
  return serial(async () => {
    const index = await readIndex();
    const meta: SaveMeta = { id: newId(), kind, time: Date.now(), name, size: bytes.length };
    if (kind === 'version') {
      meta.number = Math.max(0, ...index.filter((m) => m.kind === 'version' && m.name === name).map((m) => m.number ?? 0)) + 1;
      if (note) meta.note = note;
    }
    await kv.put(bytesKey(meta.id), bytes);
    index.push(meta);
    const autos = index.filter((m) => m.kind === 'auto').sort((a, b) => b.time - a.time);
    const drop = new Set(autos.slice(AUTOSAVE_KEEP).map((m) => m.id));
    for (const id of drop) await kv.del(bytesKey(id));
    await kv.put(INDEX, index.filter((m) => !drop.has(m.id)));
    return meta;
  });
}

export function deleteSave(id: string): Promise<void> {
  return serial(async () => {
    const index = await readIndex();
    await kv.del(bytesKey(id));
    await kv.put(INDEX, index.filter((m) => m.id !== id));
  });
}

/** The newest autosave the start-up prompt should offer (null when there is none, or it was dismissed). */
export async function pendingAutosave(): Promise<SaveMeta | null> {
  const latest = (await listSaves()).find((m) => m.kind === 'auto');
  if (!latest) return null;
  return (await kv.get(DISMISSED)) === latest.id ? null : latest;
}

/** "Start fresh" on the start-up prompt: don't offer this autosave again (it stays in the history). */
export async function dismissAutosave(id: string) {
  await kv.put(DISMISSED, id);
}

/** Asks the browser not to evict saved projects under storage pressure (best effort). */
export function requestPersistentStorage() {
  void navigator.storage?.persist?.().catch(() => false);
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  const e = await navigator.storage?.estimate?.().catch(() => null);
  return e?.usage !== undefined && e.quota !== undefined ? { usage: e.usage, quota: e.quota } : null;
}
