import type { App } from '../app';
import { BLEND_MODES, GEN_LABELS, GEN_TYPES, MAP_KEYS, defaultGenerator, hasMaps, type ChannelKey, type FillLayer, type Layer, type MaterialMaps, type MaterialValues, type ChannelSet } from '../engine/layers';
import type { TextureStore } from '../engine/library';
import { displaySettings, importDecalsAction, saveMaterialDialog, saveSmartMaterialDialog } from './actions';
import { decalUrl } from './libraryUI';
import { checkbox, colorField, h, iconButton, section, selectField, slider } from './dom';
import { ICONS } from './icons';
import { brushTipControls, stencilControls } from './brushUI';
import { FACE_MODES } from '../engine/faceSelect';
import { MATERIALS, SMART_MATERIALS } from '../data/materials';

const CHANNEL_LABELS: Record<ChannelKey, string> = {
  color: 'Base Color',
  roughness: 'Roughness',
  metallic: 'Metallic',
  height: 'Height',
  normal: 'Normal',
  emissive: 'Emissive',
  opacity: 'Opacity (alpha)',
};

/** Channel toggles + values (shared by the brush and fill layers). Textured channels show their map instead. */
function channelEditor(
  values: MaterialValues,
  channels: ChannelSet,
  onChange: () => void,
  maps?: MaterialMaps | null,
  store?: TextureStore,
): HTMLElement {
  const texChip = (k: ChannelKey) => {
    const id = (MAP_KEYS as readonly string[]).includes(k) ? maps?.[k as (typeof MAP_KEYS)[number]] : undefined;
    if (!id) return null;
    const name = store?.asset(id)?.name ?? 'texture';
    const label = k === 'roughness' && maps?.gloss ? `${name} (gloss, inverted)` : name;
    return h('div', { class: 'field' }, h('label', {}, CHANNEL_LABELS[k]), h('span', { class: 'tex-chip', title: label }, label));
  };
  const rows: HTMLElement[] = [];
  const toggle = (k: ChannelKey) =>
    h('input', {
      type: 'checkbox',
      class: 'chan-toggle',
      checked: channels[k],
      title: `Enable ${CHANNEL_LABELS[k]}`,
      onchange: (e: Event) => {
        channels[k] = (e.target as HTMLInputElement).checked;
        row.get(k)!.classList.toggle('disabled', !channels[k]);
        onChange();
      },
    });
  const row = new Map<ChannelKey, HTMLElement>();
  const add = (k: ChannelKey, field: HTMLElement) => {
    const r = h('div', { class: `chan-row ${channels[k] ? '' : 'disabled'}` }, toggle(k), field);
    row.set(k, r);
    rows.push(r);
  };
  add('color', colorField(maps?.color ? 'Tint' : 'Base Color', values.color, (c) => ((values.color = c), onChange())));
  if (maps?.color) rows.push(h('div', { class: 'chan-row' }, h('span', { style: { width: '13px' } }), texChip('color')!));
  add('roughness', texChip('roughness') ?? slider('Roughness', { value: values.roughness, min: 0, max: 1, onInput: (v) => ((values.roughness = v), onChange()) }));
  add('metallic', texChip('metallic') ?? slider('Metallic', { value: values.metallic, min: 0, max: 1, onInput: (v) => ((values.metallic = v), onChange()) }));
  add(
    'height',
    texChip('height') ??
      slider('Height', { value: values.height, min: 0, max: 1, onInput: (v) => ((values.height = v), onChange()), title: '0.5 = flat, above raises, below carves' }),
  );
  add(
    'normal',
    texChip('normal') ??
      h('div', { class: 'field', title: 'Without a normal map this writes a flat normal, which erases normal detail below' }, h('label', {}, 'Normal'), h('span', { class: 'dim small' }, 'flat (no map)')),
  );
  add('emissive', colorField('Emissive', values.emissive ?? [0, 0, 0], (c) => ((values.emissive = c), onChange())));
  add(
    'opacity',
    slider('Opacity (alpha)', {
      value: values.opacity ?? 1,
      min: 0,
      max: 1,
      onInput: (v) => ((values.opacity = v), onChange()),
      title: 'Surface transparency: exported as base color alpha',
    }),
  );
  return h('div', { class: 'channels' }, ...rows);
}

export function mountPropsPanel(app: App, root: HTMLElement) {
  const tabs = h('div', { class: 'tabs' });
  const body = h('div', { class: 'panel-body' });
  let tab: 'props' | 'scene' = 'props';
  root.append(tabs, body);

  function brushSection(): HTMLElement {
    const b = app.brush;
    const l = app.selected;
    const maskMode = app.part === 'mask' && !!l?.mask;
    const title = `${app.tool === 'erase' ? 'Eraser' : 'Brush'}${maskMode ? ' · painting mask' : ''}`;
    const common = [
      slider('Size', { value: b.size, min: 1, max: 400, step: 1, onInput: (v) => ((b.size = v), app.emit('tool')) }),
      slider('Hardness', { value: b.hardness, min: 0, max: 1, onInput: (v) => (b.hardness = v) }),
      slider('Opacity', { value: b.opacity, min: 0, max: 1, onInput: (v) => (b.opacity = v) }),
      slider('Spacing', { value: b.spacing, min: 0.02, max: 1, onInput: (v) => (b.spacing = v), title: 'Distance between stamps relative to the brush radius' }),
      selectField(
        'Symmetry',
        [['off', 'Off'], ['x', 'Mirror X'], ['y', 'Mirror Y'], ['z', 'Mirror Z']] as const,
        b.symmetry,
        (v) => ((b.symmetry = v), app.emit('tool')),
      ),
      h(
        'div',
        { class: 'row' },
        checkbox('Pressure → size', b.pressureSize, (v) => (b.pressureSize = v)),
        checkbox('Pressure → opacity', b.pressureOpacity, (v) => (b.pressureOpacity = v)),
      ),
      ...brushTipControls(app, render),
      ...stencilControls(app, render),
    ];
    if (maskMode) {
      return section(
        title,
        h(
          'div',
          { class: 'row mask-value' },
          slider('Mask value', { value: b.maskValue, min: 0, max: 1, onInput: (v) => (b.maskValue = v), title: 'White reveals the layer, black hides it' }),
          iconButton(ICONS.swap, 'Swap black / white (X)', () => ((b.maskValue = 1 - b.maskValue), render())),
        ),
        ...common,
      );
    }
    return section(
      title,
      app.tool === 'paint'
        ? [
            h('div', { class: 'brush-material' }, h('span', { class: 'dim' }, 'Material: '), b.materialName),
            channelEditor(b.values, b.channels, () => (b.materialName = 'Custom'), b.maps, app.textures),
            ...mapControls(b, () => undefined, () => ((b.maps = null), (b.materialName = 'Custom'), render())),
          ]
        : h('div', { class: 'dim small' }, 'Erases the enabled channels of the paint layer.'),
      app.tool === 'erase' ? channelToggles(b.channels) : null,
      ...common,
    );
  }

  /** Polygon fill tool: selection mode, selection commands and what to do with the selected faces. */
  let syncFaces = () => {};
  function faceSection(): HTMLElement {
    const b = app.brush;
    const l = app.selected;
    const modes = FACE_MODES.map(([id, label, title], i) =>
      h('button', { class: 'seg-btn', title: `${title} (${i + 1})`, onclick: () => app.setFaceMode(id) }, label),
    );
    const count = h('span', { class: 'face-count' });
    syncFaces = () => {
      modes.forEach((m, i) => m.classList.toggle('active', app.faces.mode === FACE_MODES[i][0]));
      const n = app.selectedFaceCount;
      const [lo, hi] = app.faceRange;
      count.textContent = app.mesh ? `${n.toLocaleString()} of ${(hi - lo).toLocaleString()} triangles selected` : 'No mesh';
    };
    syncFaces();
    const btn = (label: string, title: string, fn: () => void, cls = 'btn small') => h('button', { class: cls, title, onclick: fn }, label);
    const layerActions = !l
      ? [h('div', { class: 'dim small' }, 'Select a layer to show or hide it on these faces.')]
      : [
          h('div', { class: 'small' }, h('span', { class: 'dim' }, 'Selected layer: '), l.name),
          h(
            'div',
            { class: 'row wrap' },
            btn('Show here', `Mask "${l.name}" so it shows on the selected faces (adds a mask if it has none)`, () => app.maskFaces(true)),
            btn('Hide here', `Mask "${l.name}" out of the selected faces`, () => app.maskFaces(false)),
            ...(l.kind === 'paint'
              ? [
                  btn('Fill with brush', `Paint the brush material onto the selected faces of "${l.name}"`, () => app.paintFaces(false)),
                  btn('Erase', `Erase the brush's channels from the selected faces of "${l.name}"`, () => app.paintFaces(true)),
                ]
              : []),
          ),
        ];
    return section(
      'Polygon Fill',
      h('div', { class: 'seg face-modes' }, ...modes),
      h(
        'div',
        { class: 'row face-sel' },
        count,
        h('div', { class: 'spacer' }),
        btn('All', 'Select every face of this texture set (Ctrl+A)', () => app.selectAllFaces(true)),
        btn('None', 'Clear the selection (Esc)', () => app.selectAllFaces(false)),
        btn('Invert', 'Invert the selection (Ctrl+I)', () => app.invertFaces()),
      ),
      h('div', { class: 'dim small' }, 'Click or drag over faces to select them, Ctrl to deselect, Shift+drag to box-select the visible faces.'),
      h('div', { class: 'face-head' }, 'Assign a material'),
      h('div', { class: 'brush-material' }, h('span', { class: 'dim' }, 'Brush material: '), b.materialName),
      channelEditor(b.values, b.channels, () => (b.materialName = 'Custom'), b.maps, app.textures),
      btn('Assign to selected faces', 'New fill layer with the brush material, masked to the selected faces', () => app.assignMaterialToFaces(), 'btn primary'),
      h('div', { class: 'dim small' }, 'Or click a material or smart material in the shelf to assign it.'),
      h('div', { class: 'face-head' }, 'Selected layer'),
      ...layerActions,
    );
  }

  /** Decal tool: which decal, how deep its relief goes, and which channels it paints. */
  function decalSection(): HTMLElement {
    const d = app.decal;
    const b = app.brush;
    const decals = app.library.decals;
    const picker = h(
      'div',
      { class: 'decal-picker' },
      ...decals.map((x) =>
        h(
          'button',
          { class: `decal-pick ${x.id === d.id ? 'active' : ''}`, title: x.name, onclick: () => ((d.id = x.id), app.emit('brush')) },
          h('img', { class: 'decal-img', src: decalUrl(app, x) ?? '', alt: x.name, draggable: false }),
        ),
      ),
      h('button', { class: 'decal-pick add', title: 'Import images as decals', onclick: () => void importDecalsAction(app) }, '+'),
    );
    const maskMode = app.part === 'mask' && !!app.selected?.mask;
    return section(
      `Decal${maskMode ? ' · into mask' : ''}`,
      decals.length
        ? picker
        : h('div', { class: 'empty-decals' }, h('div', { class: 'dim small' }, 'No decals yet. Import images (logos, stickers, signs, bullet holes…): plain backgrounds are removed and a height map is made automatically.'), picker),
      h('div', { class: 'dim small' }, 'Click the model to place it; drag before releasing to size and rotate it (Shift snaps). Mirror symmetry applies.'),
      slider('Default size', { value: b.size, min: 4, max: 400, step: 1, onInput: (v) => ((b.size = v), app.emit('tool')), title: 'Size when you click without dragging' }),
      slider('Default angle', { value: b.angle, min: -180, max: 180, step: 1, onInput: (v) => (b.angle = v), title: 'Rotation when you click without dragging' }),
      slider('Opacity', { value: b.opacity, min: 0, max: 1, onInput: (v) => (b.opacity = v) }),
      maskMode
        ? h('div', { class: 'dim small' }, 'Painting the layer mask: the decal’s shape is stamped with the mask value.')
        : [
            h(
              'div',
              { class: 'row wrap' },
              checkbox('Color', d.channels.color, (v) => (d.channels.color = v)),
              checkbox('Height', d.channels.height, (v) => ((d.channels.height = v), render())),
              checkbox('Roughness', d.channels.roughness, (v) => ((d.channels.roughness = v), render())),
              checkbox('Metallic', d.channels.metallic, (v) => ((d.channels.metallic = v), render())),
            ),
            d.channels.height ? slider('Depth', { value: d.depth, min: 0, max: 0.5, onInput: (v) => (d.depth = v), title: 'How far the decal’s automatic relief raises the surface' }) : null,
            d.channels.roughness ? slider('Roughness', { value: b.values.roughness, min: 0, max: 1, onInput: (v) => (b.values.roughness = v) }) : null,
            d.channels.metallic ? slider('Metallic', { value: b.values.metallic, min: 0, max: 1, onInput: (v) => (b.values.metallic = v) }) : null,
          ],
    );
  }

  function channelToggles(c: ChannelSet) {
    return h('div', { class: 'row wrap' }, ...(Object.keys(CHANNEL_LABELS) as ChannelKey[]).map((k) => checkbox(CHANNEL_LABELS[k], c[k], (v) => (c[k] = v))));
  }

  function layerSection(l: Layer): HTMLElement {
    const changed = () => app.layerChanged();
    const commit = () => app.layerChanged(true);
    const opacity = slider('Opacity', { value: l.opacity, min: 0, max: 1, onInput: (v) => ((l.opacity = v), changed()), onCommit: commit });
    if (l.kind === 'group') {
      return section(
        `Folder · ${l.name}`,
        opacity,
        folderColors(l),
        h('div', { class: 'dim small' }, 'The folder’s layers are composited together, then blended over the layers below through the folder’s mask and opacity.'),
        libraryLink(l, 'smart'),
      );
    }
    const parts: (HTMLElement | null)[] = [
      opacity,
      selectField('Blend (color)', BLEND_MODES.map((m) => [m, m[0].toUpperCase() + m.slice(1)] as const), l.blend, (v) => ((l.blend = v), commit())),
      selectField('Blend (height/normal)', [['add', 'Add (relative)'], ['normal', 'Replace']] as const, l.heightBlend, (v) => ((l.heightBlend = v), commit())),
    ];
    if (l.kind === 'fill') {
      parts.push(
        h('div', { class: 'subhead' }, 'Fill material'),
        channelEditor(
          l.values,
          l.channels,
          () => {
            changed();
            scheduleCommit();
          },
          l.maps,
          app.textures,
        ),
        ...mapControls(l, changed, () => ((l.maps = null), app.layerChanged(true), render())),
        slider('Variation', { value: l.variation, min: 0, max: 1, onInput: (v) => ((l.variation = v), changed()), title: 'Procedural noise applied to color, roughness and height' }),
        slider('Variation scale', { value: l.variationScale, min: 0.5, max: 60, step: 0.5, onInput: (v) => ((l.variationScale = v), changed()) }),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn small', onclick: () => ((l.seed = Math.random() * 100), changed()) }, 'New random seed'),
        ),
        libraryLink(l, 'material'),
      );
    } else {
      parts.push(
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn small', onclick: () => fillPaintLayer(l) }, 'Fill layer with brush material'),
          h('button', { class: 'btn small', onclick: () => clearPaintLayer(l) }, 'Clear'),
        ),
      );
    }
    return section(`Layer · ${l.name}`, ...parts);
  }

  /**
   * Saving back to the library: "Update" when the layer / folder came from one of the user's own items, otherwise
   * (built-in or never saved) only "Save as new".
   */
  function libraryLink(l: Layer, kind: 'material' | 'smart'): HTMLElement {
    const src = app.librarySource(l);
    const what = kind === 'smart' ? 'smart material' : 'material';
    const saveNew = h(
      'button',
      { class: 'btn small', onclick: () => (kind === 'smart' ? saveSmartMaterialDialog(app) : saveMaterialDialog(app)), title: `Add it to your library as a new ${what}` },
      src ? `Save as new ${what}…` : `Save as ${what}…`,
    );
    if (!src) {
      const id = l.source?.id;
      const builtin = !!id && (kind === 'smart' ? SMART_MATERIALS : MATERIALS).some((x) => x.id === id);
      return h(
        'div',
        { class: 'lib-link' },
        builtin ? h('div', { class: 'dim small' }, `From a built-in ${what}. Save it as your own to reuse your changes.`) : null,
        h('div', { class: 'row' }, saveNew),
      );
    }
    const update = h(
      'button',
      {
        class: 'btn small primary',
        title: `Overwrite “${src.name}” in your library with these settings`,
        onclick: () => (kind === 'smart' ? app.updateSmartFromFolder(l.id) : app.updateMaterialFromFill(l.id)),
      },
      `Update “${src.name}”`,
    );
    return h('div', { class: 'lib-link' }, h('div', { class: 'dim small' }, `From your ${what} “${src.name}”.`), h('div', { class: 'row' }, update, saveNew));
  }

  /**
   * Every colour of the fill layers inside a folder in one place, so a smart material can be recoloured
   * without opening it. Layers with their colour channel off are skipped (they don't affect the colour).
   */
  function folderColors(group: Layer & { kind: 'group' }): HTMLElement | null {
    const fills: FillLayer[] = [];
    const walk = (ls: Layer[]) => {
      for (const c of ls) {
        if (c.kind === 'group') walk(c.children);
        else if (c.kind === 'fill' && (c.channels.color || c.channels.emissive)) fills.push(c);
      }
    };
    walk(group.children);
    if (!fills.length) return null;
    const changed = () => {
      app.layerChanged();
      scheduleCommit();
    };
    // Top of the stack first, like the layer list.
    const rows = fills.reverse().flatMap((f) => [
      f.channels.color ? colorField(f.maps?.color ? `${f.name} (tint)` : f.name, f.values.color, (c) => ((f.values.color = c), changed())) : null,
      f.channels.emissive ? colorField(`${f.name} (emissive)`, f.values.emissive ?? [0, 0, 0], (c) => ((f.values.emissive = c), changed())) : null,
    ]);
    return h('div', { class: 'folder-colors' }, h('div', { class: 'subhead' }, 'Colors'), ...rows);
  }

  /** Tiling + remove button for textured materials. */
  function mapControls(target: { maps: MaterialMaps | null; tiling: number }, changed: () => void, remove: () => void): HTMLElement[] {
    if (!hasMaps(target.maps)) return [];
    return [
      slider('Tiling', {
        value: target.tiling,
        min: 0.25,
        max: 40,
        step: 0.25,
        onInput: (v) => ((target.tiling = v), changed()),
        title: 'How many times the texture repeats across the model (triplanar projection)',
      }),
      h('button', { class: 'btn small', onclick: remove }, 'Remove textures'),
    ];
  }

  let commitTimer = 0;
  function scheduleCommit() {
    clearTimeout(commitTimer);
    commitTimer = window.setTimeout(() => app.layerChanged(true), 250);
  }

  function fillPaintLayer(l: Layer) {
    if (l.kind !== 'paint') return;
    app.part = 'content';
    app.fillSelected(false);
  }

  function clearPaintLayer(l: Layer) {
    if (l.kind !== 'paint') return;
    const prev = app.brush.channels;
    const prevOpacity = app.brush.opacity;
    app.part = 'content';
    app.brush.channels = { color: true, roughness: true, metallic: true, height: true, normal: true, emissive: true, opacity: true };
    app.brush.opacity = 1;
    app.fillSelected(true);
    app.brush.channels = prev;
    app.brush.opacity = prevOpacity;
  }

  function fillMask(l: Layer, value: number) {
    if (!l.mask) return;
    const prev = app.brush.maskValue;
    const prevOpacity = app.brush.opacity;
    app.part = 'mask';
    app.brush.maskValue = value;
    app.brush.opacity = 1;
    app.fillSelected(false);
    app.brush.maskValue = prev;
    app.brush.opacity = prevOpacity;
    app.emit('selection');
  }

  function maskSection(l: Layer): HTMLElement {
    if (!l.mask) {
      return section(
        'Mask',
        h('div', { class: 'dim small' }, 'Masks control where this layer is visible. Add a painted mask or a procedural generator.'),
        h(
          'div',
          { class: 'row wrap' },
          h('button', { class: 'btn small', onclick: () => app.addMask(l.id, 'white') }, 'White mask'),
          h('button', { class: 'btn small', onclick: () => app.addMask(l.id, 'black') }, 'Black mask'),
          h('button', { class: 'btn small', onclick: () => app.addMask(l.id, 'white', { type: 'edge' }) }, 'Edge wear'),
          h('button', { class: 'btn small', onclick: () => app.addMask(l.id, 'white', { type: 'dirt' }) }, 'Dirt'),
        ),
      );
    }
    const m = l.mask;
    const g = m.generator;
    const changed = () => app.layerChanged();
    const parts: (HTMLElement | null)[] = [
      h(
        'div',
        { class: 'row' },
        checkbox('Enabled', m.enabled, (v) => ((m.enabled = v), changed())),
        h(
          'button',
          {
            class: `btn small ${app.part === 'mask' ? 'primary' : ''}`,
            onclick: () => app.select(l.id, app.part === 'mask' ? 'content' : 'mask'),
            title: 'Toggle painting into the mask (M)',
          },
          app.part === 'mask' ? 'Painting mask' : 'Paint mask',
        ),
        h('button', { class: 'btn small danger', onclick: () => app.removeMask(l.id) }, 'Remove'),
      ),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn small', onclick: () => fillMask(l, 1) }, 'Fill white'),
        h('button', { class: 'btn small', onclick: () => fillMask(l, 0) }, 'Fill black'),
      ),
      selectField(
        'Generator',
        GEN_TYPES.map((t) => [t, GEN_LABELS[t]] as const),
        g?.type ?? 'none',
        (t) => {
          m.generator = t === 'none' ? null : { ...defaultGenerator(t), seed: g?.seed ?? Math.random() * 100 };
          app.layerChanged(true);
          render();
        },
      ),
    ];
    if (g) {
      parts.push(
        slider('Amount', { value: g.amount, min: 0, max: 1, onInput: (v) => ((g.amount = v), changed()) }),
        slider('Contrast', { value: g.contrast, min: 0, max: 1, onInput: (v) => ((g.contrast = v), changed()) }),
        g.type !== 'noise' ? slider('Noise breakup', { value: g.noiseAmount, min: 0, max: 1, onInput: (v) => ((g.noiseAmount = v), changed()) }) : null,
        slider('Noise scale', { value: g.noiseScale, min: 0.5, max: 60, step: 0.5, onInput: (v) => ((g.noiseScale = v), changed()) }),
        g.type === 'gradient'
          ? selectField('Axis', [[0, 'X'], [1, 'Y'], [2, 'Z']] as const, g.axis, (v) => ((g.axis = v), changed()))
          : null,
        h(
          'div',
          { class: 'row' },
          checkbox('Invert', g.invert, (v) => ((g.invert = v), changed())),
          h('button', { class: 'btn small', onclick: () => ((g.seed = Math.random() * 100), changed()) }, 'New seed'),
        ),
        h('div', { class: 'dim small' }, 'The painted mask is multiplied with the generator, so you can paint black to remove wear by hand.'),
      );
    }
    return section('Mask', ...parts);
  }

  function render() {
    tabs.replaceChildren(
      h('button', { class: `tab ${tab === 'props' ? 'active' : ''}`, onclick: () => ((tab = 'props'), render()) }, 'Properties'),
      h('button', { class: `tab ${tab === 'scene' ? 'active' : ''}`, onclick: () => ((tab = 'scene'), render()) }, 'Display'),
    );
    const scroll = body.scrollTop;
    if (tab === 'scene') {
      body.replaceChildren(section('Viewport & Maps', displaySettings(app)));
      return;
    }
    const l = app.selected;
    body.replaceChildren(app.tool === 'select' ? faceSection() : app.tool === 'decal' ? decalSection() : brushSection(), ...(l ? [layerSection(l), maskSection(l)] : [h('div', { class: 'empty' }, 'No layer selected.')]));
    body.scrollTop = scroll;
  }

  app.on((k) => {
    if (k === 'selection' || k === 'brush' || k === 'mesh' || k === 'settings' || k === 'tool') render();
    else if (k === 'faces' || k === 'set') syncFaces();
  });
  // "Update …" buttons follow renames and deletions in the library.
  app.library.onChange(() => tab === 'props' && render());
  render();
}
