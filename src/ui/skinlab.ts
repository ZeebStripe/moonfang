import type { App } from '../app';
import {
  DEFAULT_EYE,
  DEFAULT_SKIN,
  EYE_PRESETS,
  GRIME_PATTERNS,
  GRIME_PRESETS,
  SKIN_PRESETS,
  buildEyeMaterial,
  buildGrimeMaterial,
  buildSkinMaterial,
  grimeCoat,
  skinTone,
  type EyeParams,
  type GrimeCoat,
  type SkinParams,
} from '../data/skinlab';
import { openModal } from './actions';
import { checkbox, colorField, h, iconButton, selectField, slider } from './dom';
import { ICONS } from './icons';
import { LOOK_AXES } from '../engine/generators';

const swatch = (rgb: [number, number, number]) => `rgb(${rgb.map((v) => Math.round(v * 255)).join(',')})`;

/** Skin Lab dialog: tune skin or eyes, then add the result to the layer stack as a folder of fill layers. */
export function skinLabDialog(app: App, tab: 'skin' | 'eyes' = 'skin') {
  const skin: SkinParams = { ...DEFAULT_SKIN, grime: [] };
  const eye: EyeParams = { ...DEFAULT_EYE, iris: [...DEFAULT_EYE.iris], gaze: [0, 0], pupilOffset: [0, 0] };
  let current = tab;

  const body = h('div', { class: 'skinlab', 'data-testid': 'skinlab' });
  const preview = h('div', { class: 'skinlab-preview', 'data-testid': 'skinlab-preview' });

  const refreshPreview = () => {
    preview.style.background = (current === 'skin' ? buildSkinMaterial(skin) : buildEyeMaterial(eye)).preview;
  };

  /** One coat's card: kind, colour, coverage, smoothness and pattern, with reorder / reseed / remove buttons. */
  const coatCard = (c: GrimeCoat, i: number) => {
    const g = skin.grime;
    const move = (d: number) => {
      [g[i], g[i + d]] = [g[i + d], g[i]];
      render();
    };
    return h(
      'div',
      { class: 'skinlab-coat', 'data-testid': 'skinlab-coat' },
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'dot', style: { background: swatch(c.color) } }),
        h('input', {
          type: 'text',
          class: 'coat-name',
          value: c.name,
          'aria-label': 'Coat name',
          oninput: (e: Event) => (c.name = (e.target as HTMLInputElement).value),
        }),
        // The list is drawn top coat first, like the layer stack, so "up" moves a coat later in the array.
        i < g.length - 1 ? iconButton(ICONS.up, 'Move up (over the coat above)', () => move(1)) : null,
        i > 0 ? iconButton(ICONS.down, 'Move down', () => move(-1)) : null,
        h('button', { class: 'btn small', title: 'Move the pattern to new spots', onclick: () => ((c.seed = Math.round(Math.random() * 1000) + 0.37), refreshPreview()) }, 'Reshuffle'),
        iconButton(ICONS.trash, 'Remove coat', () => (g.splice(i, 1), render())),
      ),
      colorField('Color', c.color, (v) => ((c.color = v), refreshPreview())),
      slider('Amount', { value: c.amount, min: 0, max: 1, onInput: (v) => ((c.amount = v), refreshPreview()) }),
      slider('Smoothness', { value: c.smoothness, min: 0, max: 1, onInput: (v) => (c.smoothness = v) }),
      selectField('Collects in', GRIME_PATTERNS, c.pattern, (v) => (c.pattern = v)),
    );
  };

  const grimeSection = () =>
    h(
      'div',
      { class: 'skinlab-grime' },
      h('div', { class: 'section-title' }, 'Grime coats'),
      h(
        'div',
        { class: 'row wrap' },
        ...GRIME_PRESETS.map((p) =>
          h(
            'button',
            { class: 'btn small', title: `Add a ${p.name.toLowerCase()} coat on top`, onclick: () => (skin.grime.push(grimeCoat(p.name, skin.grime)), render()) },
            h('span', { class: 'dot', style: { background: swatch(p.color) } }),
            ` + ${p.name}`,
          ),
        ),
      ),
      skin.grime.length
        ? [
            ...skin.grime.map(coatCard).reverse(),
            h(
              'div',
              { class: 'row' },
              h(
                'button',
                {
                  class: 'btn small',
                  'data-testid': 'skinlab-add-grime',
                  title: 'Add only the grime coats, as their own folder over whatever is selected',
                  onclick: () => app.addSmartMaterial(buildGrimeMaterial(skin.grime)),
                },
                'Add coats only',
              ),
            ),
          ]
        : h('div', { class: 'dim small' }, 'Stack dirt, oil, soot and more over the skin. The top card is the top layer.'),
    );

  const render = () => {
    const skinPane = h(
      'div',
      { class: 'skinlab-pane' },
      h(
        'div',
        { class: 'row wrap' },
        ...SKIN_PRESETS.map((p) =>
          h(
            'button',
            {
              class: 'btn small',
              title: `${p.name} skin tone`,
              onclick: () => (Object.assign(skin, p.params), render()),
            },
            h('span', { class: 'dot', style: { background: swatch(skinTone(p.params.melanin ?? skin.melanin, p.params.undertone ?? skin.undertone)) } }),
            ` ${p.name}`,
          ),
        ),
      ),
      slider('Skin tone', { value: skin.melanin, min: 0, max: 1, onInput: (v) => ((skin.melanin = v), refreshPreview()) }),
      slider('Undertone (cool ↔ warm)', { value: skin.undertone, min: -1, max: 1, onInput: (v) => ((skin.undertone = v), refreshPreview()) }),
      slider('Blush', { value: skin.redness, min: 0, max: 1, onInput: (v) => ((skin.redness = v), refreshPreview()) }),
      slider('Freckles', { value: skin.freckles, min: 0, max: 1, onInput: (v) => ((skin.freckles = v), refreshPreview()) }),
      checkbox('Pores', skin.poresOn, (v) => ((skin.poresOn = v), render())),
      skin.poresOn && slider('Pore depth', { value: skin.pores, min: 0, max: 1, onInput: (v) => ((skin.pores = v), refreshPreview()) }),
      slider('Oiliness', { value: skin.oiliness, min: 0, max: 1, onInput: (v) => ((skin.oiliness = v), refreshPreview()) }),
      h('div', { class: 'dim small' }, 'Blush follows convex areas (cheeks, nose, brow) and the shading follows the baked ambient occlusion, so it fits any head or body. Freckles are projected in 3D and need no special UVs.'),
      grimeSection(),
    );
    const eyePane = h(
      'div',
      { class: 'skinlab-pane' },
      h(
        'div',
        { class: 'row wrap' },
        ...EYE_PRESETS.map((p) =>
          h(
            'button',
            { class: 'btn small', title: `${p.name} eyes`, onclick: () => ((eye.iris = [...p.iris]), render()) },
            h('span', { class: 'dot', style: { background: swatch(p.iris) } }),
            ` ${p.name}`,
          ),
        ),
      ),
      colorField('Iris color', eye.iris, (c) => ((eye.iris = c), refreshPreview())),
      slider('Iris size', { value: eye.irisRadius, min: 0.15, max: 0.45, onInput: (v) => ((eye.irisRadius = v), refreshPreview()) }),
      slider('Pupil size', { value: eye.pupilRadius, min: 0.03, max: 0.2, onInput: (v) => ((eye.pupilRadius = v), refreshPreview()) }),
      slider('Iris fibers', { value: eye.fibers, min: 0, max: 1, onInput: (v) => ((eye.fibers = v), refreshPreview()) }),
      slider('Limbal ring', { value: eye.limbal, min: 0, max: 1, onInput: (v) => ((eye.limbal = v), refreshPreview()) }),
      slider('Bloodshot veins', { value: eye.veins, min: 0, max: 1, onInput: (v) => ((eye.veins = v), refreshPreview()) }),
      h('div', { class: 'skinlab-sub' }, 'Placement'),
      slider('Look left ↔ right', { value: eye.gaze[0], min: -0.5, max: 0.5, onInput: (v) => ((eye.gaze[0] = v), refreshPreview()) }),
      slider('Look down ↔ up', { value: eye.gaze[1], min: -0.5, max: 0.5, onInput: (v) => ((eye.gaze[1] = v), refreshPreview()) }),
      slider('Pupil left ↔ right', { value: eye.pupilOffset[0], min: -0.2, max: 0.2, onInput: (v) => ((eye.pupilOffset[0] = v), refreshPreview()) }),
      slider('Pupil down ↔ up', { value: eye.pupilOffset[1], min: -0.2, max: 0.2, onInput: (v) => ((eye.pupilOffset[1] = v), refreshPreview()) }),
      h('button', { class: 'btn small', onclick: () => ((eye.gaze = [0, 0]), (eye.pupilOffset = [0, 0]), render()) }, 'Centre'),
      selectField('Mapping', [['sphere', 'Sphere (any UVs)'], ['uv', 'UV disc']] as const, eye.mapping, (v) => ((eye.mapping = v), render())),
      eye.mapping === 'sphere' ? selectField('Looks toward', LOOK_AXES, eye.axis, (v) => (eye.axis = v)) : null,
      h(
        'div',
        { class: 'dim small' },
        eye.mapping === 'sphere'
          ? 'Sphere mapping puts the iris where each eyeball’s surface faces the look direction, so both eyes get one and it stays round however the UVs are laid out. Look sliders turn the gaze (±0.5 = 60°). After adding, the layers’ Mask section moves the whole eye too.'
          : 'UV mapping draws the iris as a disc centred in the 0–1 UV square, for eye textures laid out that way. Look sliders shift the disc in UV units.',
      ),
    );
    body.replaceChildren(
      h(
        'div',
        { class: 'seg' },
        h('button', { class: `seg-btn ${current === 'skin' ? 'active' : ''}`, 'data-testid': 'skinlab-tab-skin', onclick: () => ((current = 'skin'), render()) }, 'Skin'),
        h('button', { class: `seg-btn ${current === 'eyes' ? 'active' : ''}`, 'data-testid': 'skinlab-tab-eyes', onclick: () => ((current = 'eyes'), render()) }, 'Eyes'),
      ),
      preview,
      current === 'skin' ? skinPane : eyePane,
    );
    refreshPreview();
  };
  render();

  const close = openModal('Skin Lab', body, [
    h('button', { class: 'btn', onclick: () => close() }, 'Close'),
    h(
      'button',
      {
        class: 'btn primary',
        'data-testid': 'skinlab-add',
        onclick: () => app.addSmartMaterial(current === 'skin' ? buildSkinMaterial(skin) : buildEyeMaterial(eye)),
      },
      'Add to layers',
    ),
  ]);
}
