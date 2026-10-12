import type { App } from '../app';
import type { MaterialPreset, SmartMaterial } from '../data/materials';
import type { Decal } from '../engine/decals';
import { downloadBlob } from '../engine/exporter';
import { renderMaterialThumbnails } from '../engine/thumbnails';
import { errorMessage, importLibraryAction, openModal, safeName } from './actions';
import { colorField, h, slider } from './dom';

/** A material or smart material in the shelf (built-in, or the user's own: `custom`), or one of the user's decals. */
export type LibraryItem = MaterialPreset | SmartMaterial | Decal;
const isSmart = (x: LibraryItem): x is SmartMaterial => 'layers' in x;
const isDecal = (x: LibraryItem): x is Decal => 'maskId' in x;
const isOwn = (x: LibraryItem) => isDecal(x) || !!x.custom;

const decalUrls = new Map<string, string>();

/** Preview image of a decal (its colour + transparency image). */
export function decalUrl(app: App, d: Decal): string | null {
  let url = decalUrls.get(d.maskId);
  const asset = app.textures.asset(d.maskId);
  if (!url && asset) {
    url = URL.createObjectURL(new Blob([asset.bytes as BlobPart], { type: asset.mime }));
    decalUrls.set(d.maskId, url);
  }
  return url ?? null;
}

// ------------------------------------------------------------------------------------------- previews

const materialThumbs = new Map<string, string>();

/** Rendered ball preview of a user material (null until its textures are decoded). */
export function customMaterialThumb(app: App, m: MaterialPreset): string | null {
  const key = `${m.id}|${JSON.stringify(m.values)}|${JSON.stringify(m.maps ?? null)}|${m.tiling ?? 4}`;
  const cached = materialThumbs.get(key);
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
  materialThumbs.set(key, url);
  return url;
}

/** Small preview element for any library item (smart material previews fill in once rendered). */
function itemPreview(app: App, item: LibraryItem): HTMLElement {
  if (isDecal(item)) return h('img', { class: 'decal-img', src: decalUrl(app, item) ?? '', alt: '', draggable: false });
  const url = isSmart(item) ? app.smartPreviews.get(item) : item.custom ? customMaterialThumb(app, item) : null;
  if (url) return h('img', { src: url, alt: '', draggable: false });
  const bg = isSmart(item) ? item.preview : `rgb(${item.values.color.map((v) => Math.round(v * 255)).join(',')})`;
  return h('div', { class: 'swatch', style: { background: bg } });
}

// ------------------------------------------------------------------------------------------- actions

/** Downloads the given items (with their texture images) as one .mflib file. */
export function exportItems(app: App, items: LibraryItem[], fileName?: string) {
  if (!items.length) return app.toast('Nothing selected to export.', 'warn');
  const mats = items.filter((x): x is MaterialPreset => !isSmart(x) && !isDecal(x));
  const smart = items.filter(isSmart);
  const decals = items.filter(isDecal);
  const name = fileName ?? (items.length === 1 ? safeName(items[0].name) : 'my_materials');
  try {
    downloadBlob(app.library.exportFile(mats, smart, decals) as BlobPart, `${name}.mflib`, 'application/zip');
    app.toast(`Exported ${items.length === 1 ? `"${items[0].name}"` : `${items.length} items`} — share the .mflib file; it can be imported with Library ▾ → Import or dropped onto Moonfang.`);
  } catch (e) {
    app.toast(`Could not export library: ${errorMessage(e)}`, 'error');
  }
}

export function duplicateItem(app: App, item: MaterialPreset | SmartMaterial) {
  const copy = app.library.duplicate(item);
  app.toast(
    item.custom
      ? `Duplicated as "${copy.name}"`
      : `"${copy.name}" copied to your library. Add it to a layer, change it, then press Update in the layer properties.`,
  );
}

export function renameDialog(app: App, item: LibraryItem) {
  const name = h('input', { type: 'text', value: item.name, maxLength: 60 }) as HTMLInputElement;
  const group = h('input', { type: 'text', value: item.group ?? '', placeholder: 'e.g. Wood, Sci-fi, Project X', maxLength: 40, list: 'lib-groups' }) as HTMLInputElement;
  const go = h('button', { class: 'btn primary' }, 'Save');
  const close = openModal(
    isDecal(item) ? 'Decal' : isSmart(item) ? 'Smart Material' : 'Material',
    h('div', { class: 'form' }, h('div', { class: 'field' }, h('label', {}, 'Name'), name), h('div', { class: 'field' }, h('label', {}, 'Category'), group), groupList(app)),
    [go],
  );
  const save = () => {
    app.library.update(item.id, { name: name.value, group: group.value });
    close();
  };
  go.addEventListener('click', save);
  for (const el of [name, group]) el.addEventListener('keydown', (e) => e.key === 'Enter' && save());
  name.focus();
  name.select();
}

/**
 * Edits one of the user's materials in place: name, color, roughness, metallic, height and variation, with a live
 * preview. Channels that come from a texture show the texture instead (the maps are not changed here). Layers that
 * already use the material keep their own settings until they are updated from it.
 */
export function editMaterialDialog(app: App, item: MaterialPreset) {
  const draft: MaterialPreset = structuredClone(item);
  const v = draft.values;
  const maps = draft.maps;
  const name = h('input', { type: 'text', value: draft.name, maxLength: 60 }) as HTMLInputElement;
  const preview = h('img', { class: 'mat-edit-preview', alt: '', draggable: false }) as HTMLImageElement;
  let queued = 0;
  const refresh = () => {
    window.clearTimeout(queued);
    queued = window.setTimeout(() => {
      if (!app.textures.ready(maps)) return;
      [preview.src] = renderMaterialThumbnails(app.renderer, app.viewport.scene.environment, [
        {
          values: v,
          color: app.textures.get(maps?.color),
          roughness: maps?.gloss ? null : app.textures.get(maps?.roughness),
          metallic: app.textures.get(maps?.metallic),
          tiling: draft.tiling,
        },
      ]);
    }, 30);
  };
  const tex = (label: string, id: string | undefined, field: () => HTMLElement) =>
    id ? h('div', { class: 'field' }, h('label', {}, label), h('span', { class: 'tex-chip' }, app.textures.asset(id)?.name ?? 'texture')) : field();
  const num = (label: string, key: 'roughness' | 'metallic' | 'height', title?: string) =>
    slider(label, { value: v[key], min: 0, max: 1, title, onInput: (x) => ((v[key] = x), refresh()) });
  const body = h(
    'div',
    { class: 'form mat-edit' },
    h('div', { class: 'mat-edit-head' }, preview, h('div', { class: 'field' }, h('label', {}, 'Name'), name)),
    colorField(maps?.color ? 'Tint' : 'Base Color', v.color, (c) => ((v.color = c), refresh())),
    tex('Roughness', maps?.roughness, () => num('Roughness', 'roughness')),
    tex('Metallic', maps?.metallic, () => num('Metallic', 'metallic')),
    tex('Height', maps?.height, () => num('Height', 'height', '0.5 = flat, above raises, below carves')),
    slider('Variation', { value: draft.variation ?? 0, min: 0, max: 1, title: 'Procedural noise applied to color, roughness and height', onInput: (x) => (draft.variation = x || undefined) }),
    maps ? slider('Tiling', { value: draft.tiling ?? 4, min: 0.25, max: 32, step: 0.25, onInput: (x) => ((draft.tiling = x), refresh()) }) : null,
  );
  const go = h('button', { class: 'btn primary' }, 'Save');
  const close = openModal('Edit material', body, [go], () => window.clearTimeout(queued));
  const save = () => {
    draft.name = name.value.trim() || item.name;
    app.library.updateMaterial(draft);
    app.toast(`Saved "${draft.name}". Layers made from it keep their settings: press Update in a layer's panel to apply the change.`);
    close();
  };
  go.addEventListener('click', save);
  name.addEventListener('keydown', (e) => e.key === 'Enter' && save());
  refresh();
  name.focus();
  name.select();
}

/** Deletes from the library as one undo step (Ctrl+Z, or Undo in the toast). */
function deleteItems(app: App, items: LibraryItem[]): boolean {
  if (!items.length) return false;
  app.deleteFromLibrary(items.map((x) => x.id));
  return true;
}

/** Category suggestions: the categories already used in the library. */
function groupList(app: App): HTMLElement {
  const groups = [...new Set([...app.library.materials, ...app.library.smart, ...app.library.decals].map((x) => x.group).filter(Boolean))] as string[];
  return h('datalist', { id: 'lib-groups' }, ...groups.sort().map((g) => h('option', { value: g })));
}

// ------------------------------------------------------------------------------------------- menus

/** A popup menu at a screen position (closes on any outside click or Escape). */
export function popupMenu(content: HTMLElement[], pos: { left: number; top?: number; bottom?: number }, anchor?: HTMLElement): () => void {
  document.querySelector('.popup-menu')?.remove();
  const menu = h('div', { class: 'popup-menu' }, ...content);
  Object.assign(menu.style, { left: `${pos.left}px`, ...(pos.top !== undefined && { top: `${pos.top}px` }), ...(pos.bottom !== undefined && { bottom: `${pos.bottom}px` }) });
  const close = () => {
    menu.remove();
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', esc, true);
  };
  const outside = (e: MouseEvent) => !menu.contains(e.target as Node) && e.target !== anchor && close();
  const esc = (e: KeyboardEvent) => e.key === 'Escape' && close();
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('keydown', esc, true);
  document.body.append(menu);
  // Keep it on screen.
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth - 4) menu.style.left = `${Math.max(4, window.innerWidth - r.width - 4)}px`;
  if (r.bottom > window.innerHeight - 4) menu.style.top = `${Math.max(4, window.innerHeight - r.height - 4)}px`;
  return close;
}

export const menuItem = (label: string, fn: () => void, title?: string, cls = '') => h('button', { title, class: cls, onclick: fn }, label);

/** Right-click menu of a shelf tile. */
export function itemMenu(app: App, item: LibraryItem, e: MouseEvent) {
  e.preventDefault();
  const run = (fn: () => void) => () => (close(), fn());
  const content = isOwn(item)
    ? [
        isDecal(item) || isSmart(item) ? null : menuItem('Edit material…', run(() => editMaterialDialog(app, item)), 'Change its color, roughness, metallic and height'),
        menuItem('Rename / category…', run(() => renameDialog(app, item))),
        isDecal(item) ? null : menuItem('Duplicate', run(() => duplicateItem(app, item))),
        menuItem('Export (.mflib)…', run(() => exportItems(app, [item])), 'Save it as a file to share or back up'),
        h('div', { class: 'menu-sep' }),
        menuItem('Delete', run(() => deleteItems(app, [item])), undefined, 'danger'),
      ]
    : [
        h('div', { class: 'menu-heading' }, 'Built-in'),
        menuItem('Make an editable copy', run(() => duplicateItem(app, item as MaterialPreset | SmartMaterial)), 'Adds a copy to your library that you can change and update'),
      ];
  const close = popupMenu(content.filter((x) => !!x) as HTMLElement[], { left: e.clientX, top: e.clientY });
}

// ------------------------------------------------------------------------------------------- manager

/** Every user material and smart material: rename, categorise, duplicate, export (all or some) and delete. */
export function libraryManagerDialog(app: App) {
  const picked = new Set<string>();
  const body = h('div', { class: 'lib-manager' });
  const count = h('span', { class: 'dim small' });
  const exportSel = h('button', { class: 'btn' }, 'Export selected');
  const deleteSel = h('button', { class: 'btn' }, 'Delete selected');
  const importBtn = h('button', { class: 'btn' }, 'Import…');
  openModal('My Library', body, [count, importBtn, deleteSel, exportSel]);
  body.closest('.modal')?.classList.add('wide');

  const all = (): LibraryItem[] => [...app.library.materials, ...app.library.smart, ...app.library.decals];
  const selected = () => all().filter((x) => picked.has(x.id));
  exportSel.addEventListener('click', () => exportItems(app, selected()));
  deleteSel.addEventListener('click', () => deleteItems(app, selected()) && picked.clear());
  importBtn.addEventListener('click', () => void importLibraryAction(app));

  const row = (item: LibraryItem) => {
    const check = h('input', { type: 'checkbox', checked: picked.has(item.id), title: 'Select' }) as HTMLInputElement;
    check.addEventListener('change', () => (check.checked ? picked.add(item.id) : picked.delete(item.id), sync()));
    const name = h('input', { type: 'text', value: item.name, maxLength: 60, title: 'Name' }) as HTMLInputElement;
    name.addEventListener('change', () => app.library.update(item.id, { name: name.value }));
    const group = h('input', { type: 'text', value: item.group ?? '', placeholder: 'Category', maxLength: 40, list: 'lib-groups', title: 'Category (groups it on the shelf)' }) as HTMLInputElement;
    group.addEventListener('change', () => app.library.update(item.id, { group: group.value }));
    const info = isDecal(item) ? 'decal' : isSmart(item) ? `${item.layers.length} layer${item.layers.length === 1 ? '' : 's'}` : item.maps ? 'textured' : '';
    return h(
      'div',
      { class: 'lib-row' },
      check,
      h('div', { class: 'lib-thumb' }, itemPreview(app, item)),
      h('div', { class: 'lib-fields' }, name, h('div', { class: 'lib-sub' }, group, h('span', { class: 'dim small' }, info))),
      isDecal(item) ? h('span', { class: 'lib-spacer' }) : h('button', { class: 'btn small', title: 'Add a copy', onclick: () => duplicateItem(app, item) }, 'Duplicate'),
      h('button', { class: 'btn small', title: 'Save this item as a .mflib file to share', onclick: () => exportItems(app, [item]) }, 'Export'),
      h('button', { class: 'btn small', title: 'Delete', onclick: () => deleteItems(app, [item]) && picked.delete(item.id) }, 'Delete'),
    );
  };

  const sync = () => {
    const n = picked.size;
    count.textContent = n ? `${n} selected` : '';
    exportSel.disabled = deleteSel.disabled = !n;
  };

  const render = () => {
    for (const id of [...picked]) if (!all().some((x) => x.id === id)) picked.delete(id);
    const section = (title: string, items: LibraryItem[], empty: string) => [
      h(
        'div',
        { class: 'subhead lib-head' },
        title,
        items.length
          ? h(
              'button',
              {
                class: 'btn small',
                onclick: () => {
                  const allOn = items.every((x) => picked.has(x.id));
                  items.forEach((x) => (allOn ? picked.delete(x.id) : picked.add(x.id)));
                  render();
                },
              },
              'Select all',
            )
          : null,
      ),
      ...(items.length ? sortByGroup(items).map(row) : [h('div', { class: 'dim small' }, empty)]),
    ];
    // Keep the scroll position and the focused field across re-renders.
    const scroll = body.scrollTop;
    body.replaceChildren(
      h('p', { class: 'dim small' }, 'Your own materials, smart materials and decals. Edit a material by adding it to a layer, changing it there, and pressing Update in the layer’s properties. Right-click a built-in in the shelf to make an editable copy.'),
      groupList(app),
      ...section('Materials', app.library.materials, 'None yet. Save a fill layer as a material, import a texture set, or copy a built-in.'),
      ...section('Smart Materials', app.library.smart, 'None yet. Save a folder of fill layers as a smart material, or copy a built-in.'),
      ...section('Decals', app.library.decals, 'None yet. Import images in the Decals tab of the shelf.'),
    );
    body.scrollTop = scroll;
    sync();
  };
  render();
  // Refresh when the library changes, but not while typing in one of the fields (that would steal the focus).
  const refresh = () => {
    if (!body.isConnected) return unsubscribe();
    const a = document.activeElement as HTMLInputElement | null;
    if (a && body.contains(a) && a.type === 'text') return;
    render();
  };
  const offLib = app.library.onChange(refresh);
  const offPreviews = app.smartPreviews.onUpdate(refresh);
  const unsubscribe = () => (offLib(), offPreviews());
}

/** Items sorted by category (uncategorised first), then name. */
export function sortByGroup<T extends LibraryItem>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '') || a.name.localeCompare(b.name));
}
