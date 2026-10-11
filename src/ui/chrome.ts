import type { App } from '../app';
import { DEMO_MESHES } from '../engine/meshLoader';
import { VIEW_MODES, type ViewMode } from '../engine/viewport';
import {
  aboutDialog,
  bakeDialog,
  busyWarning,
  exportDialog,
  importLibraryAction,
  importTextureSetAction,
  openDemo,
  openMeshDialog,
  openMeshFolderDialog,
  openProjectDialog,
  openKofi,
  openModal,
  openProjectFile,
  reportBug,
  saveProjectAction,
  shortcutsDialog,
} from './actions';
import { h, icon, iconButton, selectField } from './dom';
import { ICONS } from './icons';
import { savesDialog, saveVersionDialog } from './saves';
import { checkForUpdates } from './updates';
import { fromDropEntries, fromFiles, openModelFiles, zipKind } from './modelFiles';
import { VERSION_LABEL } from '../meta';

type MenuItem = { label: string; action: () => void; shortcut?: string } | 'sep' | { heading: string };

function menu(label: string, items: () => MenuItem[]): HTMLElement {
  const btn = h('button', { class: 'menu-btn' }, label);
  btn.addEventListener('click', () => {
    if (document.querySelector('.popup-menu')) return;
    const pop = h(
      'div',
      { class: 'popup-menu' },
      ...items().map((it) => {
        if (it === 'sep') return h('div', { class: 'menu-sep' });
        if ('heading' in it) return h('div', { class: 'menu-heading' }, it.heading);
        return h('button', { onclick: () => (close(), it.action()) }, h('span', {}, it.label), it.shortcut ? h('kbd', {}, it.shortcut) : null);
      }),
    );
    const r = btn.getBoundingClientRect();
    Object.assign(pop.style, { top: `${r.bottom + 2}px`, left: `${r.left}px` });
    const close = () => {
      pop.remove();
      document.removeEventListener('mousedown', outside, true);
    };
    const outside = (e: MouseEvent) => !pop.contains(e.target as Node) && e.target !== btn && close();
    document.addEventListener('mousedown', outside, true);
    document.body.append(pop);
  });
  return btn;
}

export function mountTopbar(app: App, root: HTMLElement) {
  const viewSelect = h('div');
  const resSelect = h('div');
  const renderSelects = () => {
    viewSelect.replaceChildren(
      h(
        'div',
        { class: 'seg', title: '3D model or 2D UV layout (U)' },
        h('button', { class: `seg-btn ${app.uvView ? '' : 'active'}`, onclick: () => app.setUVView(false) }, '3D'),
        h('button', { class: `seg-btn ${app.uvView ? 'active' : ''}`, onclick: () => app.setUVView(true) }, '2D'),
      ),
      selectField('View', VIEW_MODES, app.viewport.mode, (m: ViewMode) => {
        app.viewport.setMode(m);
        app.invalidate();
      }),
    );
    resSelect.replaceChildren(
      selectField('Texture', [[512, '512'], [1024, '1024'], [2048, '2048'], [4096, '4096']] as const, app.texSize, async (v) => {
        if (busyWarning(app)) return renderSelects();
        if (v === 4096 && !confirm('4096² uses a lot of GPU memory (~1 GB with undo history). Continue?')) return renderSelects();
        await app.setResolution(v);
      }),
    );
  };
  app.on((k) => (k === 'view' || k === 'settings' || k === 'mesh') && renderSelects());
  renderSelects();

  root.append(
    h('div', { class: 'brand' }, h('span', { class: 'logo' }), 'Moonfang', h('span', { class: 'version-badge', title: 'Public beta — please report bugs (Help → Report a Bug)' }, VERSION_LABEL)),
    menu('File', () => [
      { label: 'Open Mesh…', action: () => void openMeshDialog(app), shortcut: 'Ctrl+O' },
      { label: 'Open Mesh Folder…', action: () => void openMeshFolderDialog(app) },
      { heading: 'Demo meshes' },
      ...DEMO_MESHES.map((d) => ({ label: `   ${d.label}`, action: () => void openDemo(app, d.id) })),
      'sep',
      { label: 'Open Project…', action: () => void openProjectDialog(app) },
      { label: 'Save Project', action: () => saveProjectAction(app), shortcut: 'Ctrl+S' },
      { label: 'Save Version…', action: () => saveVersionDialog(app), shortcut: 'Ctrl+Alt+S' },
      { label: 'Saved Versions…', action: () => savesDialog(app) },
      'sep',
      { label: 'Export…', action: () => exportDialog(app), shortcut: 'Ctrl+E' },
    ]),
    menu('Edit', () => [
      { label: 'Undo', action: () => app.undo(), shortcut: 'Ctrl+Z' },
      { label: 'Redo', action: () => app.redo(), shortcut: 'Ctrl+Shift+Z' },
      'sep',
      { label: 'Add Paint Layer', action: () => app.addPaintLayer() },
      { label: 'Add Fill Layer', action: () => app.addFillLayer() },
    ]),
    menu('Mesh', () => [
      { label: 'Bake Mesh Maps…', action: () => bakeDialog(app) },
      { label: 'Frame Model', action: () => app.viewport.frame(), shortcut: 'F' },
    ]),
    menu('Help', () => [
      { label: 'Shortcuts', action: () => shortcutsDialog(), shortcut: '?' },
      'sep',
      { label: 'Report a Bug…', action: () => reportBug(app) },
      { label: 'Check for Updates…', action: () => void checkForUpdates(app, true) },
      { label: 'Support Moonfang on Ko-fi ♥', action: () => openKofi() },
      'sep',
      { label: `About Moonfang (${VERSION_LABEL})`, action: () => aboutDialog() },
    ]),
    h('div', { class: 'spacer' }),
    resSelect,
    viewSelect,
    h('button', { class: 'btn primary', onclick: () => exportDialog(app) }, 'Export'),
  );
}

export function mountToolbar(app: App, root: HTMLElement) {
  const paint = iconButton(ICONS.brush, 'Paint (B)', () => app.setTool('paint'), 'tool');
  const erase = iconButton(ICONS.eraser, 'Erase (E)', () => app.setTool('erase'), 'tool');
  const undo = iconButton(ICONS.undo, 'Undo (Ctrl+Z)', () => app.undo());
  const redo = iconButton(ICONS.redo, 'Redo (Ctrl+Shift+Z)', () => app.redo());
  const frame = iconButton(ICONS.frame, 'Frame model (F)', () => app.viewport.frame());
  root.append(paint, erase, h('div', { class: 'tool-sep' }), undo, redo, h('div', { class: 'tool-sep' }), frame);
  const sync = () => {
    paint.classList.toggle('active', app.tool === 'paint');
    erase.classList.toggle('active', app.tool === 'erase');
    undo.disabled = !app.canUndo;
    redo.disabled = !app.canRedo;
    undo.title = app.undoLabel ? `Undo ${app.undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
    redo.title = app.redoLabel ? `Redo ${app.redoLabel} (Ctrl+Shift+Z)` : 'Redo (Ctrl+Shift+Z)';
  };
  app.on(sync);
  sync();
}

export function mountStatusbar(app: App, root: HTMLElement) {
  const left = h('span', {}, 'LMB paint · Alt+LMB / MMB orbit · RMB pan · Wheel zoom · Ctrl+RMB drag brush size / hardness · ? shortcuts');
  const right = h('span', { class: 'dim' });
  root.append(left, h('div', { class: 'spacer' }), right);
  const gl = app.renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)).replace(/^ANGLE \((.*)\)$/, '$1').split(',').slice(0, 2).join(',') : '';
  const sync = () => {
    const tris = app.mesh ? app.mesh.geometry.attributes.position.count / 3 : 0;
    right.textContent = [app.mesh ? `${app.mesh.name} · ${Math.round(tris).toLocaleString()} tris` : 'No mesh', app.sets.length > 1 ? `set ${app.set.info.name}` : '', `${app.texSize}²`, `${app.allLayers.length} layers`, app.lastAutosave ? `autosaved ${new Date(app.lastAutosave).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '', gpu]
      .filter(Boolean)
      .join('  ·  ');
  };
  app.on(sync);
  sync();
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (e.key === '?' && !(t.tagName === 'INPUT' || t.tagName === 'SELECT')) shortcutsDialog();
  });
}

export function mountToasts(app: App) {
  const box = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  document.body.append(box);
  app.onToast((msg, kind, action) => {
    const btn = action ? h('button', { class: 'btn small', onclick: () => (action.run(), t.remove()) }, action.label) : null;
    const t = h('div', { class: `toast ${kind}${action ? ' has-action' : ''}` }, h('span', {}, msg), btn);
    box.append(t);
    const life = action ? 12000 : kind === 'info' ? 2600 : 6000;
    setTimeout(() => t.classList.add('out'), life);
    setTimeout(() => t.remove(), life + 400);
  });
}

export function mountProgress(app: App) {
  const label = h('div', { class: 'progress-label' });
  const bar = h('div', { class: 'progress-bar' });
  const overlay = h('div', { class: 'progress-overlay' }, h('div', { class: 'progress-card' }, label, h('div', { class: 'progress-track' }, bar)));
  document.body.append(overlay);
  app.onProgress((p) => {
    overlay.classList.toggle('show', p.active);
    label.textContent = p.label;
    bar.style.width = `${Math.round(p.value * 100)}%`;
  });
}

export function mountDropZone(app: App, target: HTMLElement) {
  const veil = h(
    'div',
    { class: 'drop-veil' },
    icon(ICONS.plus),
    h('div', {}, 'Drop a mesh (.glb .obj .fbx, or a .gltf with its files, folder or .zip),'),
    h('div', {}, 'a project (.mfp), an HDRI (.hdr),'),
    h('div', {}, 'texture-set images (one material) or a material library (.mflib)'),
  );
  target.append(veil);
  let depth = 0;
  target.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    depth++;
    veil.classList.add('show');
  });
  target.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) veil.classList.remove('show');
  });
  target.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  target.addEventListener('drop', async (e) => {
    depth = 0;
    veil.classList.remove('show');
    const dt = e.dataTransfer;
    if (!dt) return;
    e.preventDefault();
    // Folder entries are only readable during the event itself, so take them before the first await.
    const entries = Array.from(dt.items)
      .map((i) => i.webkitGetAsEntry?.())
      .filter((x): x is FileSystemEntry => !!x);
    const files = Array.from(dt.files);
    if (entries.some((en) => en.isDirectory)) return void openModelFiles(app, await fromDropEntries(entries));
    const file = files[0];
    if (!file) return;
    const ext = file.name.split('.').pop()!.toLowerCase();
    const isImage = (f: File) => /\.(png|jpe?g|webp|avif)$/i.test(f.name);
    if (files.every(isImage)) await importTextureSetAction(app, files);
    else if (ext === 'mflib' || ext === 'json') await importLibraryAction(app, file);
    else if (ext === 'mfp') await openProjectFile(app, file);
    else if (ext === 'zip' && files.length === 1) {
      // A .zip is a project, a material library or a zipped model: tell by its contents.
      let kind: ReturnType<typeof zipKind>;
      try {
        kind = zipKind(new Uint8Array(await file.arrayBuffer()));
      } catch (err) {
        return app.toast(`Could not read ${file.name}: ${err instanceof Error ? err.message : err}`, 'error');
      }
      if (kind === 'project') await openProjectFile(app, file);
      else if (kind === 'library') await importLibraryAction(app, file);
      else await openModelFiles(app, fromFiles(files));
    } else if (ext === 'hdr') {
      await app.viewport.loadHDR(file);
      app.toast(`Environment: ${file.name}`);
    } else await openModelFiles(app, fromFiles(files)); // all dropped files: a .gltf finds its .bin among them
  });
}

/** After a GPU driver reset every layer texture is gone: explain, and offer a reload into the autosave prompt. */
export function mountGpuLossDialog(app: App) {
  app.on((k) => {
    if (k !== 'gpu') return;
    const when = app.lastAutosave ? new Date(app.lastAutosave).toLocaleTimeString() : null;
    const reload = h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Reload Moonfang');
    openModal(
      'The graphics driver reset',
      h(
        'div',
        { class: 'form' },
        h('p', {}, 'The GPU stopped responding (usually a very heavy bake or texture size for this graphics card) and the painted layers were lost from video memory.'),
        h(
          'p',
          {},
          when
            ? `Reload Moonfang and choose Restore to continue from the autosave made at ${when}. Changes since then are lost.`
            : 'Reload Moonfang to continue. Earlier autosaves and versions are under File → Saved Versions.',
        ),
        h('p', { class: 'dim small' }, 'If this keeps happening, try a smaller texture size or fewer AO samples, and please report it (Help → Report a Bug).'),
      ),
      [reload],
    );
  });
}

/**
 * Phones and tablets: Moonfang needs a mouse or pen and a large screen. Resolves once the user continues anyway
 * (immediately on desktop).
 */
export function deviceNotice(): Promise<void> {
  const touchOnly = matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
  // A hidden or headless window can report a 0×0 screen; only real small screens count.
  const tiny = screen.width > 0 && Math.min(screen.width, screen.height) < 600;
  if (!touchOnly && !tiny) return Promise.resolve();
  return new Promise((resolve) => {
    const go = h('button', { class: 'btn' }, 'Continue anyway');
    const close = openModal(
      'Desktop app',
      h(
        'div',
        { class: 'form' },
        h('p', {}, 'Moonfang is made for a desktop or laptop with a mouse or pen tablet. On phones and touch-only tablets the layout and painting controls won’t work properly.'),
      ),
      [go],
      () => resolve(),
    );
    go.addEventListener('click', () => close());
  });
}
