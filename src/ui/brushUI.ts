import type { App } from '../app';
import { BUILTIN_TIPS, tipPreview, type BrushTip } from '../engine/brushTips';
import type { TextureStore } from '../engine/library';
import { errorMessage } from './actions';
import { checkbox, h, icon, pickFile, slider } from './dom';
import { ICONS } from './icons';

const urls = new Map<string, string>();
/** Object URL for a stored image asset (cached). */
function assetURL(store: TextureStore, id: string): string | null {
  let u = urls.get(id);
  if (!u) {
    const a = store.asset(id);
    if (!a) return null;
    u = URL.createObjectURL(new Blob([a.bytes as BlobPart], { type: a.mime }));
    urls.set(id, u);
  }
  return u;
}

/** Semi-transparent preview of the stencil, positioned exactly where the shader samples it. */
export function mountStencilOverlay(app: App, wrap: HTMLElement) {
  const el = h('div', { class: 'stencil-overlay' });
  wrap.append(el);
  const sync = () => {
    const st = app.brush.stencil;
    const tex = app.textures.get(st.imageId ?? undefined);
    const img = tex?.image as { width: number; height: number } | undefined;
    const url = st.imageId ? assetURL(app.textures, st.imageId) : null;
    if (!st.enabled || !img || !url) {
      el.style.display = 'none';
      return;
    }
    const w = st.width;
    const hgt = (st.width * img.height) / img.width;
    // Tiled stencils get an oversized square so the rotated pattern still covers the viewport.
    const box = st.tile ? 4 * Math.max(wrap.clientWidth, wrap.clientHeight) : 0;
    Object.assign(el.style, {
      display: 'block',
      backgroundImage: `url("${url}")`,
      width: `${st.tile ? box : w}px`,
      height: `${st.tile ? box : hgt}px`,
      left: `${st.x - (st.tile ? box : w) / 2}px`,
      top: `${st.y - (st.tile ? box : hgt) / 2}px`,
      backgroundSize: st.tile ? `${w}px ${hgt}px` : '100% 100%',
      backgroundRepeat: st.tile ? 'repeat' : 'no-repeat',
      backgroundPosition: st.tile ? `${box / 2 - w / 2}px ${box / 2 - hgt / 2}px` : '0 0',
      transform: `rotate(${st.rotation}deg)`,
    });
  };
  app.on((k) => (k === 'stencil' || k === 'brush') && sync());
  app.textures.onLoad(sync);
  sync();
}

function tipTile(app: App, tip: BrushTip, rerender: () => void): HTMLElement {
  const url = tipPreview(tip, () => (tip.assetId ? assetURL(app.textures, tip.assetId) : null));
  const active = app.brush.tip === tip.id;
  return h(
    'button',
    {
      class: `tip ${active ? 'active' : ''}`,
      title: tip.name,
      onclick: () => {
        app.brush.tip = tip.id;
        rerender();
      },
    },
    url ? h('img', { src: url, alt: tip.name, draggable: false }) : tip.name.slice(0, 2),
  );
}

/** Tip picker, angle, dynamics and smoothing (shared by content and mask painting). */
export function brushTipControls(app: App, rerender: () => void): HTMLElement[] {
  const b = app.brush;
  const tips: BrushTip[] = [...BUILTIN_TIPS, ...app.library.tips.map((t) => ({ id: t.id, name: t.name, assetId: t.assetId }))];
  const importBtn = h(
    'button',
    {
      class: 'tip add',
      title: 'Import a brush tip image (white or dark-on-light both work)',
      onclick: async () => {
        const f = await pickFile('.png,.jpg,.jpeg,.webp');
        if (!f) return;
        try {
          await app.importBrushTip(f);
          rerender();
        } catch (e) {
          app.toast(`Could not import tip: ${errorMessage(e)}`, 'error');
        }
      },
    },
    icon(ICONS.plus),
  );
  const textured = b.tip !== 'round';
  return [
    h('div', { class: 'subhead' }, 'Tip'),
    h('div', { class: 'tips' }, ...tips.map((t) => tipTile(app, t, rerender)), importBtn),
    textured ? slider('Angle', { value: b.angle, min: -180, max: 180, step: 1, onInput: (v) => (b.angle = v) }) : null,
    textured ? checkbox('Follow stroke direction', b.followStroke, (v) => (b.followStroke = v)) : null,
    h('div', { class: 'subhead' }, 'Dynamics'),
    slider('Size jitter', { value: b.sizeJitter, min: 0, max: 1, onInput: (v) => (b.sizeJitter = v) }),
    textured ? slider('Angle jitter', { value: b.angleJitter, min: 0, max: 1, onInput: (v) => (b.angleJitter = v) }) : null,
    slider('Scatter', { value: b.scatter, min: 0, max: 3, onInput: (v) => (b.scatter = v), title: 'Random offset in brush radii' }),
    slider('Opacity jitter', { value: b.opacityJitter, min: 0, max: 1, onInput: (v) => (b.opacityJitter = v) }),
    slider('Smoothing', { value: b.smoothing, min: 0, max: 0.95, onInput: (v) => (b.smoothing = v), title: 'Lazy mouse: the brush trails the cursor for steadier lines' }),
  ].filter((x): x is HTMLElement => !!x);
}

export function stencilControls(app: App, rerender: () => void): HTMLElement[] {
  const st = app.brush.stencil;
  const changed = () => app.emit('stencil');
  const load = h(
    'button',
    {
      class: 'btn small',
      onclick: async () => {
        const f = await pickFile('.png,.jpg,.jpeg,.webp,.avif');
        if (!f) return;
        try {
          await app.loadStencil(f);
          rerender();
        } catch (e) {
          app.toast(`Could not load stencil: ${errorMessage(e)}`, 'error');
        }
      },
    },
    st.imageId ? 'Replace image…' : 'Load stencil image…',
  );
  if (!st.imageId) {
    return [h('div', { class: 'subhead' }, 'Stencil'), h('div', { class: 'dim small' }, 'An image fixed to the screen that masks the brush — or paints its own colors as a decal.'), load];
  }
  return [
    h('div', { class: 'subhead' }, 'Stencil'),
    h(
      'div',
      { class: 'row wrap' },
      checkbox('Enabled', st.enabled, (v) => ((st.enabled = v), changed())),
      checkbox('Use colors (decal)', st.useColor, (v) => ((st.useColor = v), changed()), 'Paint the stencil image’s colors; its alpha channel masks the brush'),
      checkbox('Tile', st.tile, (v) => ((st.tile = v), changed())),
    ),
    slider('Width', { value: st.width, min: 20, max: 4000, step: 1, onInput: (v) => ((st.width = v), changed()) }),
    slider('Rotation', { value: st.rotation, min: -180, max: 180, step: 1, onInput: (v) => ((st.rotation = v), changed()) }),
    h('div', { class: 'dim small' }, 'Hold S: drag to move · wheel to scale · Shift+wheel to rotate'),
    h(
      'div',
      { class: 'row' },
      load,
      h(
        'button',
        {
          class: 'btn small',
          onclick: () => {
            st.imageId = null;
            st.enabled = false;
            changed();
            rerender();
          },
        },
        'Remove',
      ),
    ),
  ];
}

/**
 * X / Y / Z mirror toggles in the viewport's top-right corner (one axis at a time, like the brush panel's
 * Symmetry field). Click the active axis again to turn symmetry off. Hidden in the 2D UV view, where it doesn't apply.
 */
export function mountSymmetryToggles(app: App, wrap: HTMLElement) {
  const axes = ['x', 'y', 'z'] as const;
  const buttons = axes.map((axis) =>
    h(
      'button',
      {
        class: `sym-btn sym-${axis}`,
        title: `Mirror painting across the model's ${axis.toUpperCase()} axis`,
        'aria-label': `Symmetry ${axis.toUpperCase()}`,
        onclick: () => {
          app.brush.symmetry = app.brush.symmetry === axis ? 'off' : axis;
          app.emit('tool');
          app.emit('brush');
        },
      },
      axis.toUpperCase(),
    ),
  );
  const box = h('div', { class: 'sym-toggles', title: 'Symmetry' }, h('span', { class: 'sym-label' }, 'Mirror'), ...buttons);
  wrap.append(box);
  const sync = () => {
    box.style.display = app.mesh && !app.uvView ? '' : 'none';
    axes.forEach((axis, i) => {
      const on = app.brush.symmetry === axis;
      buttons[i].classList.toggle('active', on);
      buttons[i].setAttribute('aria-pressed', String(on));
    });
  };
  app.on((k) => (k === 'brush' || k === 'tool' || k === 'view' || k === 'mesh') && sync());
  sync();
}
