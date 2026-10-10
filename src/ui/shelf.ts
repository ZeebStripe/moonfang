import type { App } from '../app';
import { MATERIALS, SMART_MASKS, SMART_MATERIALS, type MaterialPreset } from '../data/materials';
import { renderMaterialThumbnails } from '../engine/thumbnails';
import { exportLibraryAction, importLibraryAction, importTextureSetAction, saveMaterialDialog, saveSmartMaterialDialog } from './actions';
import { h, icon } from './dom';
import { ICONS } from './icons';

type ShelfTab = 'materials' | 'smart' | 'masks';

export function mountShelf(app: App, root: HTMLElement) {
  let tab: ShelfTab = 'materials';
  let filter = '';
  let builtinThumbs: string[] | null = null;
  /** custom material thumbnails, keyed by id (only cached once all their textures are decoded) */
  const customThumbs = new Map<string, string>();

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
  const libBtn = h('button', { class: 'btn small', title: 'Import / export your own materials' }, 'Library ▾');
  libBtn.addEventListener('click', () => openLibraryMenu(libBtn));
  const grid = h('div', { class: 'shelf-grid' });
  root.append(h('div', { class: 'shelf-head' }, tabs, hint, libBtn, search), grid);

  function openLibraryMenu(anchor: HTMLElement) {
    if (document.querySelector('.popup-menu')) return;
    const item = (label: string, fn: () => void, title?: string) => h('button', { title, onclick: () => (close(), fn()) }, label);
    const menu = h(
      'div',
      { class: 'popup-menu' },
      h('div', { class: 'menu-heading' }, 'Import'),
      item('Texture set (images)…', () => void importTextureSetAction(app), 'Select BaseColor / Roughness / Metallic / Height (or ARM) images of one material'),
      item('Library file (.oplib / .json)…', () => void importLibraryAction(app)),
      h('div', { class: 'menu-sep' }),
      h('div', { class: 'menu-heading' }, 'Save'),
      item('Selected fill layer as material…', () => saveMaterialDialog(app)),
      item('Layers as smart material…', () => saveSmartMaterialDialog(app)),
      h('div', { class: 'menu-sep' }),
      item('Export my library (.oplib)…', () => exportLibraryAction(app)),
    );
    const r = anchor.getBoundingClientRect();
    Object.assign(menu.style, { left: `${r.left}px`, bottom: `${window.innerHeight - r.top + 4}px` });
    const close = () => {
      menu.remove();
      document.removeEventListener('mousedown', outside, true);
    };
    const outside = (e: MouseEvent) => !menu.contains(e.target as Node) && e.target !== anchor && close();
    document.addEventListener('mousedown', outside, true);
    document.body.append(menu);
  }

  function renderTabs() {
    const t = (id: ShelfTab, label: string) => h('button', { class: `tab ${tab === id ? 'active' : ''}`, onclick: () => ((tab = id), renderTabs(), renderGrid()) }, label);
    tabs.replaceChildren(t('materials', 'Materials'), t('smart', 'Smart Materials'), t('masks', 'Smart Masks'));
    hint.textContent = {
      materials: 'Click: use on brush · + : add as fill layer',
      smart: 'Click: add layers above the selection',
      masks: 'Click: apply to the selected layer’s mask',
    }[tab];
  }

  function tile(label: string, preview: HTMLElement, onClick: () => void, extras: (HTMLElement | null)[] = [], title?: string) {
    return h(
      'div',
      { class: 'tile', title: title ?? label, onclick: onClick, tabindex: 0, onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && onClick() },
      preview,
      h('span', { class: 'tile-label' }, label),
      ...extras,
    );
  }

  function deleteButton(id: string, name: string) {
    return h(
      'button',
      {
        class: 'tile-del',
        title: `Delete "${name}" from your library`,
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          if (confirm(`Delete "${name}" from your library?`)) app.library.remove(id);
        },
      },
      icon(ICONS.close),
    );
  }

  function thumbFor(m: MaterialPreset): string | null {
    if (!m.custom) return null;
    const cached = customThumbs.get(m.id);
    if (cached) return cached;
    if (!app.textures.ready(m.maps)) return null;
    const [url] = renderMaterialThumbnails(app.renderer, app.viewport.scene.environment, [
      {
        values: m.values,
        color: app.textures.get(m.maps?.color),
        roughness: m.maps?.gloss ? null : app.textures.get(m.maps?.roughness),
        metallic: app.textures.get(m.maps?.metallic),
        tiling: m.tiling,
      },
    ]);
    customThumbs.set(m.id, url);
    return url;
  }

  function materialTile(m: MaterialPreset, img: string | null) {
    return tile(
      m.name,
      img ? h('img', { src: img, alt: '', draggable: false }) : h('div', { class: 'swatch loading' }),
      () => {
        app.setBrushMaterial(m);
        app.setTool('paint');
        app.toast(`Brush material: ${m.name}`);
      },
      [
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
        m.custom ? deleteButton(m.id, m.name) : null,
        m.maps ? h('span', { class: 'tile-badge', title: 'Texture-based material' }, 'TEX') : null,
      ],
      `${m.name} (${m.category})`,
    );
  }

  function renderGrid() {
    const match = (s: string) => !filter || s.toLowerCase().includes(filter);
    if (tab === 'materials') {
      builtinThumbs ??= renderMaterialThumbnails(app.renderer, app.viewport.scene.environment, MATERIALS.map((m) => m.values));
      const custom = app.library.materials.filter((m) => match(m.name) || match('custom'));
      const builtin = MATERIALS.map((m, i) => ({ m, i })).filter(({ m }) => match(m.name) || match(m.category));
      grid.replaceChildren(
        ...(custom.length ? [h('div', { class: 'shelf-group' }, 'My materials'), ...custom.map((m) => materialTile(m, thumbFor(m)))] : []),
        ...(custom.length ? [h('div', { class: 'shelf-group' }, 'Built-in')] : []),
        ...builtin.map(({ m, i }) => materialTile(m, builtinThumbs![i])),
      );
    } else if (tab === 'smart') {
      const all = [...app.library.smart, ...SMART_MATERIALS].filter((s) => match(s.name));
      grid.replaceChildren(
        ...all.map((s) =>
          tile(
            s.name,
            h('div', { class: 'swatch', style: { background: s.preview } }),
            () => {
              if (!app.mesh) return app.toast('Load a mesh first.', 'warn');
              app.addSmartMaterial(s);
            },
            [s.custom ? deleteButton(s.id, s.name) : null],
            `${s.name}: ${s.layers.map((l) => l.name).join(', ')}`,
          ),
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

  app.library.onChange(() => {
    for (const id of customThumbs.keys()) if (!app.library.materials.some((m) => m.id === id)) customThumbs.delete(id);
    renderGrid();
  });
  // A custom material's thumbnail can only be rendered once its images are decoded.
  let pending = 0;
  app.textures.onLoad(() => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(renderGrid);
  });

  renderTabs();
  // Thumbnails need the environment map, which exists once the viewport is constructed.
  requestAnimationFrame(renderGrid);
}
