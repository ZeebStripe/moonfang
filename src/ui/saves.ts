import type { App } from '../app';
import { downloadBlob } from '../engine/exporter';
import { AUTOSAVE_KEEP, deleteSave, listSaves, readSave, storageEstimate, type SaveMeta } from '../engine/saves';
import { busyWarning, errorMessage, openModal, safeName } from './actions';
import { describeSave, restoreSave, saveVersion } from './autosave';
import { h } from './dom';

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

/** Iterative save: asks for an optional note, then stores the next numbered version. */
export function saveVersionDialog(app: App) {
  if (!app.mesh) return app.toast('Load a mesh first.', 'warn');
  if (busyWarning(app)) return;
  const note = h('input', { type: 'text', placeholder: 'e.g. base colors done', maxLength: 80 }) as HTMLInputElement;
  const go = h('button', { class: 'btn primary' }, 'Save Version');
  const close = openModal(
    'Save Version',
    h(
      'div',
      { class: 'form' },
      h('div', { class: 'field' }, h('label', {}, 'Note (optional)'), note),
      h('p', { class: 'dim small' }, 'Versions are numbered per project and kept until you delete them. Find them under File → Saved Versions.'),
    ),
    [go],
  );
  const save = async () => {
    go.disabled = true;
    try {
      const meta = await saveVersion(app, note.value.trim() || undefined);
      if (!meta) throw new Error('Nothing to save right now.');
      app.toast(`Saved “${meta.name}” v${meta.number}`);
      close();
    } catch (e) {
      app.toast(`Could not save version: ${errorMessage(e)}`, 'error');
      go.disabled = false;
    }
  };
  go.addEventListener('click', save);
  note.addEventListener('keydown', (e) => e.key === 'Enter' && void save());
  note.focus();
}

/** Lists versions and autosaves, newest first, with restore / download / delete. */
export function savesDialog(app: App) {
  const list = h('div', { class: 'saves-list' }, h('div', { class: 'dim small' }, 'Loading…'));
  const usage = h('div', { class: 'dim small' });
  const close = openModal(
    'Saved Versions',
    h(
      'div',
      { class: 'form saves' },
      h(
        'p',
        { class: 'dim small' },
        `Versions are the ones you saved with File → Save Version. Autosaves happen every 30 seconds while you work; the newest ${AUTOSAVE_KEEP} are kept. Everything is stored in this app only — download a version to keep a copy elsewhere.`,
      ),
      list,
      usage,
    ),
  );

  const row = (m: SaveMeta) => {
    const restore = h('button', { class: 'btn small primary' }, 'Restore');
    const download = h('button', { class: 'btn small' }, 'Download');
    const del = h('button', { class: 'btn small' }, 'Delete');
    restore.addEventListener('click', async () => {
      if (busyWarning(app)) return;
      close();
      await restoreSave(app, m);
    });
    download.addEventListener('click', async () => {
      const bytes = await readSave(m.id);
      if (!bytes) return app.toast('That save could not be found.', 'error');
      const suffix = m.kind === 'version' ? `_v${String(m.number).padStart(3, '0')}` : `_autosave_${new Date(m.time).toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
      downloadBlob(bytes as BlobPart, `${safeName(m.name)}${suffix}.mfp`, 'application/zip');
    });
    del.addEventListener('click', async () => {
      if (!confirm(`Delete the ${describeSave(m)}? This can't be undone.`)) return;
      await deleteSave(m.id);
      void refresh();
    });
    const title = m.kind === 'version' ? `${m.name} · v${m.number}` : `${m.name} · autosave`;
    return h(
      'div',
      { class: `save-row ${m.kind}` },
      h(
        'div',
        { class: 'save-info' },
        h('div', { class: 'save-title' }, title, m.note ? h('span', { class: 'dim' }, ` — ${m.note}`) : null),
        h('div', { class: 'dim small' }, `${new Date(m.time).toLocaleString()} · ${mb(m.size)}`),
      ),
      restore,
      download,
      del,
    );
  };

  const refresh = async () => {
    try {
      const saves = await listSaves();
      const versions = saves.filter((m) => m.kind === 'version');
      const autos = saves.filter((m) => m.kind === 'auto');
      list.replaceChildren(
        h('div', { class: 'subhead' }, 'Versions'),
        ...(versions.length ? versions.map(row) : [h('div', { class: 'dim small' }, 'None yet — File → Save Version (Ctrl+Alt+S).')]),
        h('div', { class: 'subhead' }, 'Autosaves'),
        ...(autos.length ? autos.map(row) : [h('div', { class: 'dim small' }, 'None yet.')]),
      );
      const est = await storageEstimate();
      usage.textContent = est ? `Storage used: ${mb(est.usage)} of ${mb(est.quota)} available to Moonfang.` : '';
    } catch (e) {
      list.replaceChildren(h('div', {}, `Could not read saves: ${errorMessage(e)}`));
    }
  };
  void refresh();
}
