import type { App } from '../app';
import { MATERIALS, SMART_MASKS, SMART_MATERIALS } from '../data/materials';
import { renderMaterialThumbnails } from '../engine/thumbnails';
import { h, icon } from './dom';
import { ICONS } from './icons';

type ShelfTab = 'materials' | 'smart' | 'masks';

export function mountShelf(app: App, root: HTMLElement) {
  let tab: ShelfTab = 'materials';
  let filter = '';
  let thumbs: string[] | null = null;

  const tabs = h('div', { class: 'shelf-tabs' });
  const search = h('input', {
    type: 'search',
    class: 'shelf-search',
    placeholder: 'Filter…',
    oninput: () => {
      filter = search.value.toLowerCase();
      renderGrid();
    },
  }) as HTMLInputElement;
  const hint = h('span', { class: 'shelf-hint dim' });
  const grid = h('div', { class: 'shelf-grid' });
  root.append(h('div', { class: 'shelf-head' }, tabs, hint, search), grid);

  function renderTabs() {
    const t = (id: ShelfTab, label: string) => h('button', { class: `tab ${tab === id ? 'active' : ''}`, onclick: () => ((tab = id), renderTabs(), renderGrid()) }, label);
    tabs.replaceChildren(t('materials', 'Materials'), t('smart', 'Smart Materials'), t('masks', 'Smart Masks'));
    hint.textContent = {
      materials: 'Click: use on brush · + : add as fill layer',
      smart: 'Click: add layers above the selection',
      masks: 'Click: apply to the selected layer’s mask',
    }[tab];
  }

  function tile(label: string, preview: HTMLElement, onClick: () => void, extra?: HTMLElement, title?: string) {
    return h('div', { class: 'tile', title: title ?? label, onclick: onClick, tabindex: 0, onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && onClick() }, preview, h('span', { class: 'tile-label' }, label), extra ?? null);
  }

  function renderGrid() {
    const match = (s: string) => !filter || s.toLowerCase().includes(filter);
    if (tab === 'materials') {
      if (!thumbs) thumbs = renderMaterialThumbnails(app.renderer, app.viewport.scene.environment, MATERIALS.map((m) => m.values));
      grid.replaceChildren(
        ...MATERIALS.map((m, i) => ({ m, i }))
          .filter(({ m }) => match(m.name) || match(m.category))
          .map(({ m, i }) =>
            tile(
              m.name,
              h('img', { src: thumbs![i], alt: '', draggable: false }),
              () => {
                app.setBrushMaterial(m);
                app.setTool('paint');
                app.toast(`Brush material: ${m.name}`);
              },
              h(
                'button',
                {
                  class: 'tile-add',
                  title: `Add "${m.name}" as fill layer`,
                  onclick: (e: MouseEvent) => {
                    e.stopPropagation();
                    if (!app.mesh) return app.toast('Load a mesh first.', 'warn');
                    app.addFillLayer(m);
                  },
                },
                icon(ICONS.plus),
              ),
              `${m.name} (${m.category})`,
            ),
          ),
      );
    } else if (tab === 'smart') {
      grid.replaceChildren(
        ...SMART_MATERIALS.filter((s) => match(s.name)).map((s) =>
          tile(s.name, h('div', { class: 'swatch', style: { background: s.preview } }), () => {
            if (!app.mesh) return app.toast('Load a mesh first.', 'warn');
            app.addSmartMaterial(s);
          }, undefined, `${s.name}: ${s.layers.map((l) => l.name).join(', ')}`),
        ),
      );
    } else {
      grid.replaceChildren(
        ...SMART_MASKS.filter((s) => match(s.name)).map((s) =>
          tile(s.name, h('div', { class: 'swatch mask', style: { background: s.preview } }), () => {
            const l = app.selected;
            if (!l) return app.toast('Select a layer first.', 'warn');
            app.addMask(l.id, 'white', s.generator);
            app.toast(`Mask "${s.name}" applied to ${l.name}`);
          }),
        ),
      );
    }
  }

  renderTabs();
  // Thumbnails need the environment map, which exists once the viewport is constructed.
  requestAnimationFrame(renderGrid);
}
