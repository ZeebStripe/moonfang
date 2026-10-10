import type { App } from '../app';
import { BLEND_MODES, GEN_LABELS, GEN_TYPES, defaultGenerator, hasMaps, type ChannelKey, type Layer, type MaterialMaps, type MaterialValues, type ChannelSet } from '../engine/layers';
import type { TextureStore } from '../engine/library';
import { displaySettings, saveMaterialDialog } from './actions';
import { checkbox, colorField, h, iconButton, section, selectField, slider } from './dom';
import { ICONS } from './icons';

const CHANNEL_LABELS: Record<ChannelKey, string> = { color: 'Base Color', roughness: 'Roughness', metallic: 'Metallic', height: 'Height' };

/** Channel toggles + values (shared by the brush and fill layers). Textured channels show their map instead. */
function channelEditor(
  values: MaterialValues,
  channels: ChannelSet,
  onChange: () => void,
  maps?: MaterialMaps | null,
  store?: TextureStore,
): HTMLElement {
  const texChip = (k: ChannelKey) => {
    const id = maps?.[k];
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

  function channelToggles(c: ChannelSet) {
    return h('div', { class: 'row wrap' }, ...(Object.keys(CHANNEL_LABELS) as ChannelKey[]).map((k) => checkbox(CHANNEL_LABELS[k], c[k], (v) => (c[k] = v))));
  }

  function layerSection(l: Layer): HTMLElement {
    const changed = () => app.layerChanged();
    const commit = () => app.layerChanged(true);
    const parts: (HTMLElement | null)[] = [
      slider('Opacity', { value: l.opacity, min: 0, max: 1, onInput: (v) => ((l.opacity = v), changed()), onCommit: commit }),
      selectField('Blend (color)', BLEND_MODES.map((m) => [m, m[0].toUpperCase() + m.slice(1)] as const), l.blend, (v) => ((l.blend = v), commit())),
      selectField('Blend (height)', [['add', 'Add (relative)'], ['normal', 'Replace']] as const, l.heightBlend, (v) => ((l.heightBlend = v), commit())),
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
          h('button', { class: 'btn small', onclick: () => saveMaterialDialog(app), title: 'Add this fill material to your library' }, 'Save as material…'),
        ),
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
    app.brush.channels = { color: true, roughness: true, metallic: true, height: true };
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
    body.replaceChildren(brushSection(), ...(l ? [layerSection(l), maskSection(l)] : [h('div', { class: 'empty' }, 'No layer selected.')]));
    body.scrollTop = scroll;
  }

  app.on((k) => {
    if (k === 'selection' || k === 'brush' || k === 'mesh' || k === 'settings' || k === 'tool') render();
  });
  render();
}
