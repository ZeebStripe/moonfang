import type { App } from '../app';
import { MATERIALS, SMART_MASKS, SMART_MATERIALS, type MaterialPreset, type SmartMaterial } from '../data/materials';
import { renderMaterialThumbnails } from '../engine/thumbnails';
import { exportLibraryAction, importDecalsAction, importLibraryAction, importTextureSetAction, saveMaterialDialog, saveSmartMaterialDialog } from './actions';
import { h, icon } from './dom';
import { ICONS } from './icons';
import { customMaterialThumb, decalUrl, itemMenu, libraryManagerDialog, menuItem, popupMenu, sortByGroup } from './libraryUI';
import type { Decal } from '../engine/decals';

type ShelfTab = 'materials' | 'smart' | 'masks' | 'decals';

export function mountShelf(app: App, root: HTMLElement) {
  let tab: ShelfTab = 'materials';
  let filter = '';
  let builtinThumbs: string[] | null = null;

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
  libBtn.addEventListener('click', () => {
    if (document.querySelector('.popup-menu')) return;
    const r = libBtn.getBoundingClientRect();
    const run = (fn: () => void) => () => (close(), fn());
    const close = popupMenu(
      [
        menuItem('Manage my library…', run(() => libraryManagerDialog(app)), 'Rename, categorise, duplicate, export or delete your materials'),
        h('div', { class: 'menu-sep' }),
        h('div', { class: 'menu-heading' }, 'Import'),
        menuItem('Texture set (images)…', run(() => void importTextureSetAction(app)), 'Select BaseColor / Roughness / Metallic / Height (or ARM) images of one material'),
        menuItem('Library file (.mflib / .json)…', run(() => void importLibraryAction(app))),
        menuItem('Images as decals…', run(() => void importDecalsAction(app)), 'Logos, stickers, signs, bullet holes…: backgrounds are removed and a height map is made automatically'),
        h('div', { class: 'menu-sep' }),
        h('div', { class: 'menu-heading' }, 'Save'),
        menuItem('Selected fill layer as material…', run(() => saveMaterialDialog(app))),
        menuItem('Layers as smart material…', run(() => saveSmartMaterialDialog(app))),
        h('div', { class: 'menu-sep' }),
        menuItem('Export my whole library (.mflib)…', run(() => exportLibraryAction(app))),
      ],
      { left: r.left, bottom: window.innerHeight - r.top + 4 },
      libBtn,
    );
  });
  const grid = h('div', { class: 'shelf-grid' });
  root.append(h('div', { class: 'shelf-head' }, tabs, hint, libBtn, search), grid);

  function renderTabs() {
    const t = (id: ShelfTab, label: string) => h('button', { class: `tab ${tab === id ? 'active' : ''}`, onclick: () => ((tab = id), renderTabs(), renderGrid()) }, label);
    tabs.replaceChildren(t('materials', 'Materials'), t('smart', 'Smart Materials'), t('masks', 'Smart Masks'), t('decals', 'Decals'));
    const faces = app.tool === 'select';
    hint.textContent = {
      materials: faces ? 'Click: assign to the selected faces · + : add as fill layer' : 'Click: use on brush · + : add as fill layer',
      smart: faces ? 'Click: assign to the selected faces' : 'Click: add layers above the selection',
      masks: 'Click: apply to the selected layer’s mask',
      decals: 'Click: use with the decal tool · right-click for more',
    }[tab];
  }

  function tile(label: string, preview: HTMLElement, onClick: () => void, extras: (HTMLElement | null)[] = [], title?: string, onMenu?: (e: MouseEvent) => void) {
    return h(
      'div',
      {
        class: 'tile',
        title: title ?? label,
        onclick: onClick,
        oncontextmenu: onMenu,
        tabindex: 0,
        onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && onClick(),
      },
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

  function materialTile(m: MaterialPreset, img: string | null) {
    return tile(
      m.name,
      img ? h('img', { src: img, alt: '', draggable: false }) : h('div', { class: 'swatch loading' }),
      () => {
        if (app.tool === 'select') return app.assignMaterialToFaces(m);
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
      `${m.name} (${m.custom ? (m.group ?? 'My materials') : m.category}) · right-click for more`,
      (e) => itemMenu(app, m, e),
    );
  }

  function smartTile(s: SmartMaterial) {
    const url = app.smartPreviews.get(s);
    return tile(
      s.name,
      url ? h('img', { src: url, alt: '', draggable: false }) : h('div', { class: 'swatch', style: { background: s.preview } }),
      () => {
        if (!app.mesh) return app.toast('Load a mesh first.', 'warn');
        if (app.tool === 'select') app.assignSmartMaterialToFaces(s);
        else app.addSmartMaterial(s);
      },
      [s.custom ? deleteButton(s.id, s.name) : null],
      `${s.name}: ${s.layers.map((l) => l.name).join(', ')} · right-click for more`,
      (e) => itemMenu(app, s, e),
    );
  }

  function decalTile(d: Decal) {
    const tileEl = tile(
      d.name,
      h('img', { class: 'decal-img', src: decalUrl(app, d) ?? '', alt: '', draggable: false }),
      () => {
        app.decal.id = d.id;
        app.setTool('decal');
        app.emit('brush');
        renderGrid();
      },
      [],
      `${d.name} · click to place it on the model, right-click for more`,
      (e) => itemMenu(app, d, e),
    );
    tileEl.classList.toggle('active', app.decal.id === d.id);
    return tileEl;
  }

  /** The user's items under "My …" headings, one per category. */
  function grouped<T extends MaterialPreset | SmartMaterial | Decal>(items: T[], title: string, make: (x: T) => HTMLElement): HTMLElement[] {
    const out: HTMLElement[] = [];
    let last: string | undefined | null = null;
    for (const x of sortByGroup(items)) {
      if (x.group !== last) out.push(h('div', { class: 'shelf-group' }, x.group ? `${title} · ${x.group}` : title));
      last = x.group;
      out.push(make(x));
    }
    return out;
  }

  function renderGrid() {
    const match = (s: string) => !filter || s.toLowerCase().includes(filter);
    if (tab === 'materials') {
      builtinThumbs ??= renderMaterialThumbnails(app.renderer, app.viewport.scene.environment, MATERIALS.map((m) => m.values));
      const custom = app.library.materials.filter((m) => match(m.name) || match(m.group ?? '') || match('custom'));
      const builtin = MATERIALS.map((m, i) => ({ m, i })).filter(({ m }) => match(m.name) || match(m.category));
      grid.replaceChildren(
        ...grouped(custom, 'My materials', (m) => materialTile(m, customMaterialThumb(app, m))),
        ...(custom.length ? [h('div', { class: 'shelf-group' }, 'Built-in')] : []),
        ...builtin.map(({ m, i }) => materialTile(m, builtinThumbs![i])),
      );
    } else if (tab === 'smart') {
      const custom = app.library.smart.filter((s) => match(s.name) || match(s.group ?? ''));
      const builtin = SMART_MATERIALS.filter((s) => match(s.name));
      grid.replaceChildren(
        ...grouped(custom, 'My smart materials', smartTile),
        ...(custom.length ? [h('div', { class: 'shelf-group' }, 'Built-in')] : []),
        ...builtin.map(smartTile),
      );
    } else if (tab === 'decals') {
      const decals = app.library.decals.filter((d) => match(d.name) || match(d.group ?? ''));
      const add = tile('Import images…', h('div', { class: 'swatch add' }, icon(ICONS.plus)), () => void importDecalsAction(app), [], 'Make decals from images (PNG, JPG, WebP). Plain backgrounds are removed automatically; you can also drop images here while the decal tool is active.');
      grid.replaceChildren(...grouped(decals, 'My decals', decalTile), add);
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

  // Library changes, decoded texture images (custom thumbnails need them) and finished smart material previews.
  let pending = 0;
  const later = () => {
    clearTimeout(pending);
    pending = window.setTimeout(renderGrid, 30);
  };
  app.library.onChange(later);
  app.textures.onLoad(later);
  app.smartPreviews.onUpdate(() => tab === 'smart' && later());

  app.on((k) => {
    if (k === 'tool') renderTabs();
    // The decal tab marks the decal in use.
    if ((k === 'tool' || k === 'brush') && tab === 'decals') later();
  });
  renderTabs();
  // Thumbnails need the environment map, which exists once the viewport is constructed.
  requestAnimationFrame(renderGrid);
}
