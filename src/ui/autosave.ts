import { zip } from 'fflate';
import type { App } from '../app';
import { kv } from '../engine/library';
import { loadDemoMesh } from '../engine/meshLoader';
import { errorMessage, openModal } from './actions';
import { h } from './dom';

const KEY = 'autosave';
const INTERVAL_MS = 30_000;

interface AutosaveRecord {
  time: number;
  name: string;
  bytes: Uint8Array;
}

/**
 * Periodically stores the whole project in IndexedDB when something changed, and offers to restore it on the
 * next start. Resolves once the user has decided (or immediately when there is nothing to restore).
 */
export async function setupAutosave(app: App): Promise<boolean> {
  let restored = false;
  try {
    const rec = (await kv.get(KEY)) as AutosaveRecord | undefined;
    if (rec?.bytes?.length) restored = await askRestore(app, rec);
  } catch (e) {
    console.warn('Autosave unavailable', e);
  }

  let saved = app.revision;
  let saving = false;
  const save = async (reason: string) => {
    if (saving || !app.mesh || app.busy || app.painter.isPainting || app.revision === saved) return;
    saving = true;
    const rev = app.revision;
    try {
      // Readback is synchronous (~0.1 s per paint layer); compression runs in fflate's workers.
      const files = app.projectFiles();
      const bytes = await new Promise<Uint8Array>((res, rej) => zip(files, { level: 1 }, (err, out) => (err ? rej(err) : res(out))));
      await kv.put(KEY, { time: Date.now(), name: app.mesh.name, bytes } satisfies AutosaveRecord);
      saved = rev;
      app.lastAutosave = Date.now();
      if (reason === 'timer') app.emit('autosave');
    } catch (e) {
      console.warn('Autosave failed', e);
    } finally {
      saving = false;
    }
  };
  // A freshly loaded mesh has nothing worth saving over an older session, so treat it as clean.
  app.on((k) => k === 'mesh' && (saved = app.revision));
  setInterval(() => void save('timer'), INTERVAL_MS);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void save('hidden'));
  // Closing the window with changes newer than the last autosave: let the browser ask first.
  window.addEventListener('beforeunload', (e) => {
    if (app.mesh && app.revision !== saved) e.preventDefault();
  });
  return restored;
}

function askRestore(app: App, rec: AutosaveRecord): Promise<boolean> {
  return new Promise((resolve) => {
    const when = new Date(rec.time).toLocaleString();
    const restore = h('button', { class: 'btn primary' }, 'Restore');
    const discard = h('button', { class: 'btn' }, 'Discard');
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      close();
      resolve(v);
    };
    const close = openModal(
      'Restore previous session?',
      h(
        'div',
        { class: 'form' },
        h('p', {}, `An autosave of “${rec.name}” from ${when} was found (${(rec.bytes.length / 1e6).toFixed(1)} MB).`),
        h('p', { class: 'dim small' }, 'Discarding deletes it. Closing this dialog keeps it until the next autosave.'),
      ),
      [discard, restore],
      () => finish(false),
    );
    discard.addEventListener('click', () => {
      void kv.del(KEY);
      finish(false);
    });
    restore.addEventListener('click', async () => {
      finish(true);
      try {
        await app.loadProject(rec.bytes);
        app.toast(`Restored autosave from ${when}`);
      } catch (e) {
        app.toast(`Could not restore autosave: ${errorMessage(e)}`, 'error');
        await app.openMesh(loadDemoMesh('roundedCube'));
      }
    });
  });
}
