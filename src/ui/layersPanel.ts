import type { App } from '../app';
import { GEN_LABELS, type Layer } from '../engine/layers';
import type { PaintPart } from '../engine/painter';
import { h, icon, iconButton, srgbToHex } from './dom';
import { ICONS } from './icons';

export function mountLayersPanel(app: App, root: HTMLElement) {
  const list = h('div', { class: 'layer-list', role: 'listbox', 'aria-label': 'Layers' });
  const maskMenuBtn = iconButton(ICONS.mask, 'Add mask to selected layer', (e) => openMaskMenu(e.currentTarget as HTMLElement));

  const header = h(
    'div',
    { class: 'panel-head' },
    h('span', { class: 'panel-title' }, 'Layers'),
    h(
      'div',
      { class: 'panel-tools' },
      iconButton(ICONS.paintLayer, 'Add paint layer', () => app.addPaintLayer()),
      iconButton(ICONS.fillLayer, 'Add fill layer', () => app.addFillLayer()),
      maskMenuBtn,
      iconButton(ICONS.copy, 'Duplicate layer', () => app.selectedId && app.duplicateLayer(app.selectedId)),
      iconButton(ICONS.trash, 'Delete layer', () => app.selectedId && app.deleteLayer(app.selectedId)),
    ),
  );
  root.append(header, list);

  function openMaskMenu(anchor: HTMLElement) {
    const l = app.selected;
    if (!l) return app.toast('Select a layer first.', 'warn');
    const menu = h(
      'div',
      { class: 'popup-menu' },
      h('button', { onclick: () => (app.addMask(l.id, 'white'), close()) }, 'Add white mask (paint to hide)'),
      h('button', { onclick: () => (app.addMask(l.id, 'black'), close()) }, 'Add black mask (paint to reveal)'),
      h('div', { class: 'menu-sep' }),
      ...(['edge', 'dirt', 'facing', 'gradient', 'noise', 'ao', 'curvature'] as const).map((t) =>
        h('button', { onclick: () => (app.addMask(l.id, 'white', { type: t }), close()) }, `Generator: ${GEN_LABELS[t]}`),
      ),
      l.mask ? h('div', { class: 'menu-sep' }) : null,
      l.mask ? h('button', { class: 'danger', onclick: () => (app.removeMask(l.id), close()) }, 'Remove mask') : null,
    );
    const r = anchor.getBoundingClientRect();
    Object.assign(menu.style, { top: `${r.bottom + 4}px`, left: `${Math.max(8, r.right - 260)}px` });
    const close = () => {
      menu.remove();
      document.removeEventListener('mousedown', outside, true);
    };
    const outside = (e: MouseEvent) => !menu.contains(e.target as Node) && close();
    document.addEventListener('mousedown', outside, true);
    document.body.append(menu);
  }

  let dragId: number | null = null;

  function thumb(l: Layer, part: PaintPart): HTMLElement {
    const active = app.selectedId === l.id && app.part === part;
    const el = h('div', {
      class: `thumb ${part} ${active ? 'active' : ''}`,
      title: part === 'mask' ? 'Mask (click to paint the mask)' : 'Layer content',
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        app.select(l.id, part);
      },
    });
    if (part === 'content' && l.kind === 'fill') {
      el.style.background = l.channels.color ? srgbToHex(l.values.color) : '#555';
      el.append(icon(ICONS.fillLayer, 'thumb-icon'));
      return el;
    }
    if (part === 'mask' && l.mask?.generator && l.mask.generator.type !== 'none') {
      el.classList.add('generator');
      el.append(h('span', { class: 'gen-label' }, GEN_LABELS[l.mask.generator.type].split(' ')[0]));
    }
    const img = app.layerThumbnail(l, part, 36);
    if (img) {
      const c = h('canvas', { width: 36, height: 36 }) as HTMLCanvasElement;
      c.getContext('2d')!.putImageData(img, 0, 0);
      el.prepend(c);
    }
    return el;
  }

  function row(l: Layer, index: number): HTMLElement {
    const selected = app.selectedId === l.id;
    const name = h('span', { class: 'layer-name', title: 'Double-click to rename' }, l.name);
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const input = h('input', { type: 'text', class: 'rename', value: l.name }) as HTMLInputElement;
      const done = (commit: boolean) => {
        if (commit && input.value.trim()) l.name = input.value.trim();
        render();
      };
      input.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') done(true);
        if (ev.key === 'Escape') done(false);
      });
      input.addEventListener('blur', () => done(true));
      name.replaceWith(input);
      input.focus();
      input.select();
    });
    const el = h(
      'div',
      {
        class: `layer-row ${selected ? 'selected' : ''} ${l.visible ? '' : 'hidden-layer'}`,
        draggable: true,
        role: 'option',
        'aria-selected': selected ? 'true' : 'false',
        onclick: () => app.select(l.id, selected ? app.part : 'content'),
      },
      iconButton(l.visible ? ICONS.eye : ICONS.eyeOff, l.visible ? 'Hide layer' : 'Show layer', (e) => {
        e.stopPropagation();
        l.visible = !l.visible;
        app.layerChanged(true);
      }, 'eye'),
      thumb(l, 'content'),
      l.mask ? thumb(l, 'mask') : null,
      h('div', { class: 'layer-meta' }, name, h('span', { class: 'layer-sub' }, `${l.kind === 'paint' ? 'Paint' : 'Fill'} · ${l.blend} · ${Math.round(l.opacity * 100)}%`)),
      h(
        'div',
        { class: 'layer-order' },
        iconButton(ICONS.up, 'Move up', (e) => (e.stopPropagation(), app.moveLayer(l.id, 1))),
        iconButton(ICONS.down, 'Move down', (e) => (e.stopPropagation(), app.moveLayer(l.id, -1))),
      ),
    );
    el.addEventListener('dragstart', (e) => {
      dragId = l.id;
      e.dataTransfer!.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => {
      dragId = null;
      el.classList.remove('dragging');
    });
    el.addEventListener('dragover', (e) => {
      if (dragId === null) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const above = e.clientY < r.top + r.height / 2;
      el.classList.toggle('drop-above', above);
      el.classList.toggle('drop-below', !above);
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-above', 'drop-below'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drop-above', 'drop-below');
      if (dragId === null || dragId === l.id) return;
      const r = el.getBoundingClientRect();
      const above = e.clientY < r.top + r.height / 2;
      const from = app.layers.findIndex((x) => x.id === dragId);
      // The list is displayed top-down (highest index first). "Above" in the list = higher stack index.
      let to = above ? index + 1 : index;
      if (from < to) to--;
      app.moveLayerTo(dragId, to);
    });
    return el;
  }

  function render() {
    const rows = app.layers.map((l, i) => row(l, i)).reverse();
    list.replaceChildren(...rows);
    if (!rows.length) list.append(h('div', { class: 'empty' }, app.mesh ? 'No layers. Add a paint or fill layer.' : 'Load a mesh to start.'));
  }

  app.on((k) => {
    if (k === 'layers' || k === 'selection' || k === 'history' || k === 'mesh') render();
  });
  render();
}
