import { zip } from 'fflate';
import type { App } from '../app';
import { loadDemoMesh } from '../engine/meshLoader';
import { addSave, dismissAutosave, pendingAutosave, readSave, requestPersistentStorage, type SaveMeta } from '../engine/saves';
import { errorMessage, openModal } from './actions';
import { h } from './dom';
import { savesDialog } from './saves';

const INTERVAL_MS = 30_000;

/** Revision of the document as of the last snapshot (autosave or version). */
let saved = -1;
let saving: Promise<void> | null = null;

/** Zips the current project (GPU readback is synchronous; compression runs in fflate's workers). */
async function snapshot(app: App): Promise<Uint8Array> {
  const files = app.projectFiles();
  return new Promise<Uint8Array>((res, rej) => zip(files, { level: 1 }, (err, out) => (err ? rej(err) : res(out))));
}

function canSnapshot(app: App) {
  return !!app.mesh && !app.busy && !app.painter.isPainting && !app.contextLost;
}

/** Autosaves now if anything changed since the last snapshot. */
export async function autosaveNow(app: App, reason = 'manual'): Promise<void> {
  if (saving) return saving;
  if (!canSnapshot(app) || app.revision === saved) return;
  const rev = app.revision;
  saving = (async () => {
    try {
      const bytes = await snapshot(app);
      await addSave('auto', app.mesh!.name, bytes);
      saved = rev;
      app.lastAutosave = Date.now();
      if (reason === 'timer') app.emit('autosave');
    } catch (e) {
      console.warn('Autosave failed', e);
    } finally {
      saving = null;
    }
  })();
  return saving;
}

/** Iterative save: stores the current state as the next numbered version of this project. */
export async function saveVersion(app: App, note?: string): Promise<SaveMeta | null> {
  if (!canSnapshot(app)) return null;
  const rev = app.revision;
  const meta = await addSave('version', app.mesh!.name, await snapshot(app), note);
  saved = rev;
  requestPersistentStorage();
  return meta;
}

/** Restores a stored snapshot; unsaved changes are autosaved first, so they can be got back the same way. */
export async function restoreSave(app: App, meta: SaveMeta): Promise<boolean> {
  const bytes = await readSave(meta.id);
  if (!bytes) {
    app.toast('That save could not be found.', 'error');
    return false;
  }
  await autosaveNow(app, 'restore');
  try {
    await app.loadProject(bytes);
    app.toast(`Restored ${describeSave(meta)}`);
    return true;
  } catch (e) {
    app.toast(`Could not restore: ${errorMessage(e)}`, 'error');
    return false;
  }
}

export function describeSave(m: SaveMeta): string {
  const when = new Date(m.time).toLocaleString();
  return m.kind === 'version' ? `“${m.name}” v${m.number}${m.note ? ` (${m.note})` : ''} from ${when}` : `autosave of “${m.name}” from ${when}`;
}

/**
 * Periodically stores the whole project in IndexedDB when something changed (keeping the newest few), and offers to
 * restore the latest one on the next start. Resolves true once a project is being opened from the prompt, false
 * when the caller should start with the default mesh.
 */
export async function setupAutosave(app: App): Promise<boolean> {
  let handled = false;
  try {
    const latest = await pendingAutosave();
    if (latest) handled = await askRestore(app, latest);
  } catch (e) {
    console.warn('Autosave unavailable', e);
  }

  saved = app.revision;
  // A freshly loaded mesh or project has nothing worth saving over an older session, so treat it as clean.
  app.on((k) => k === 'mesh' && (saved = app.revision));
  setInterval(() => void autosaveNow(app, 'timer'), INTERVAL_MS);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void autosaveNow(app, 'hidden'));
  // Closing the window with changes newer than the last snapshot: let the browser ask first. After a GPU reset the
  // document is gone anyway, so don't hold the window.
  window.addEventListener('beforeunload', (e) => {
    if (app.mesh && app.revision !== saved && !app.contextLost) e.preventDefault();
  });
  return handled;
}

function askRestore(app: App, rec: SaveMeta): Promise<boolean> {
  return new Promise((resolve) => {
    const restore = h('button', { class: 'btn primary' }, 'Restore');
    const fresh = h('button', { class: 'btn' }, 'Start fresh');
    const browse = h('button', { class: 'btn' }, 'All saves…');
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
        h('p', {}, `Found the ${describeSave(rec)} (${(rec.size / 1e6).toFixed(1)} MB).`),
        h('p', { class: 'dim small' }, 'Start fresh keeps it in File → Saved Versions, together with older autosaves and your versions.'),
      ),
      [browse, fresh, restore],
      () => finish(false),
    );
    fresh.addEventListener('click', () => {
      void dismissAutosave(rec.id);
      finish(false);
    });
    browse.addEventListener('click', async () => {
      // Start from the demo mesh, then let the user pick any save.
      finish(true);
      await app.openMesh(loadDemoMesh('roundedCube'));
      savesDialog(app);
    });
    restore.addEventListener('click', async () => {
      finish(true);
      if (!(await restoreSave(app, rec))) await app.openMesh(loadDemoMesh('roundedCube'));
    });
  });
}
