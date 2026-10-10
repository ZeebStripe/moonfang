import type { App } from '../app';
import { DEMO_MESHES } from '../engine/meshLoader';
import { VIEW_MODES, type ViewMode } from '../engine/viewport';
import {
  aboutDialog,
  bakeDialog,
  exportDialog,
  importLibraryAction,
  importTextureSetAction,
  openDemo,
  openMeshDialog,
  openMeshFile,
  openProjectDialog,
  openProjectFile,
  saveProjectAction,
  shortcutsDialog,
} from './actions';
import { h, icon, iconButton, selectField } from './dom';
import { ICONS } from './icons';

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
      selectField('View', VIEW_MODES, app.viewport.mode, (m: ViewMode) => {
        app.viewport.setMode(m);
        app.invalidate();
      }),
    );
    resSelect.replaceChildren(
      selectField('Texture', [[512, '512'], [1024, '1024'], [2048, '2048'], [4096, '4096']] as const, app.texSize, async (v) => {
        if (v === 4096 && !confirm('4096² uses a lot of GPU memory (~1 GB with undo history). Continue?')) return renderSelects();
        await app.setResolution(v);
      }),
    );
  };
  app.on((k) => (k === 'view' || k === 'settings' || k === 'mesh') && renderSelects());
  renderSelects();

  root.append(
    h('div', { class: 'brand' }, h('span', { class: 'logo' }), 'Open Painter'),
    menu('File', () => [
      { label: 'Open Mesh…', action: () => void openMeshDialog(app), shortcut: 'Ctrl+O' },
      { heading: 'Demo meshes' },
      ...DEMO_MESHES.map((d) => ({ label: `   ${d.label}`, action: () => void openDemo(app, d.id) })),
      'sep',
      { label: 'Open Project…', action: () => void openProjectDialog(app) },
      { label: 'Save Project', action: () => saveProjectAction(app), shortcut: 'Ctrl+S' },
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
      { label: 'Shortcuts', action: () => shortcutsDialog() },
      { label: 'About', action: () => aboutDialog() },
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
    undo.disabled = !app.painter.canUndo;
    redo.disabled = !app.painter.canRedo;
  };
  app.on(sync);
  sync();
}

export function mountStatusbar(app: App, root: HTMLElement) {
  const left = h('span', {}, 'LMB paint · Alt+LMB / MMB orbit · RMB pan · Wheel zoom · [ ] size · ? shortcuts');
  const right = h('span', { class: 'dim' });
  root.append(left, h('div', { class: 'spacer' }), right);
  const gl = app.renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)).replace(/^ANGLE \((.*)\)$/, '$1').split(',').slice(0, 2).join(',') : '';
  const sync = () => {
    const tris = app.mesh ? app.mesh.geometry.attributes.position.count / 3 : 0;
    right.textContent = [app.mesh ? `${app.mesh.name} · ${Math.round(tris).toLocaleString()} tris` : 'No mesh', `${app.texSize}²`, `${app.layers.length} layers`, gpu]
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
  app.onToast((msg, kind) => {
    const t = h('div', { class: `toast ${kind}` }, msg);
    box.append(t);
    setTimeout(() => t.classList.add('out'), kind === 'info' ? 2600 : 6000);
    setTimeout(() => t.remove(), kind === 'info' ? 3000 : 6400);
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
    h('div', {}, 'Drop a mesh (.glb .obj .fbx), project (.opp), HDRI (.hdr),'),
    h('div', {}, 'texture-set images (one material) or a material library (.oplib)'),
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
    const files = Array.from(e.dataTransfer?.files ?? []);
    const file = files[0];
    if (!file) return;
    e.preventDefault();
    const ext = file.name.split('.').pop()!.toLowerCase();
    const isImage = (f: File) => /\.(png|jpe?g|webp|avif)$/i.test(f.name);
    if (files.every(isImage)) await importTextureSetAction(app, files);
    else if (ext === 'oplib' || ext === 'json') await importLibraryAction(app, file);
    else if (ext === 'opp' || ext === 'zip') await openProjectFile(app, file);
    else if (ext === 'hdr') {
      await app.viewport.loadHDR(file);
      app.toast(`Environment: ${file.name}`);
    } else await openMeshFile(app, file);
  });
}
