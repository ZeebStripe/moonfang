import type { App } from '../app';
import { downloadBlob, EXPORT_FORMATS, EXPORT_PRESETS, exportPrefixes, type ExportFormat } from '../engine/exporter';
import { walkLayers } from '../engine/layers';
import { loadDemoMesh, type DemoMeshId } from '../engine/meshLoader';
import { checkbox, h, pickFile, pickFiles, pickFolder, selectField, slider } from './dom';
import { fromFiles, MODEL_ACCEPT, openModelFiles, resolveModel } from './modelFiles';
import { ICONS } from './icons';
import { KOFI_URL, REPO_URL, VERSION_LABEL } from '../meta';

export function errorMessage(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

/** Open Mesh: a model, or a .gltf together with its .bin files, or a .zip of the model. */
export async function openMeshDialog(app: App) {
  const files = await pickFiles(MODEL_ACCEPT, true);
  if (files.length) await openModelFiles(app, fromFiles(files));
}

/** Open Mesh Folder: the model's whole folder (e.g. scene.gltf + scene.bin + textures/). */
export async function openMeshFolderDialog(app: App) {
  const files = await pickFolder();
  if (files.length) await openModelFiles(app, fromFiles(files));
}

export async function openDemo(app: App, id: DemoMeshId) {
  if (app.busy) return;
  await app.openMesh(loadDemoMesh(id), 'reset');
}

export async function openProjectDialog(app: App) {
  const file = await pickFile('.mfp,.zip');
  if (file) await openProjectFile(app, file);
}

export async function openProjectFile(app: App, file: File) {
  if (app.busy) return;
  try {
    await app.loadProject(new Uint8Array(await file.arrayBuffer()));
    app.toast(`Opened project ${file.name}`);
  } catch (e) {
    app.toast(`Could not open project: ${errorMessage(e)}`, 'error');
  }
}

export function saveProjectAction(app: App) {
  if (!app.mesh || app.busy) return;
  try {
    const data = app.saveProject();
    downloadBlob(data as BlobPart, `${safeName(app.mesh.name)}.mfp`, 'application/zip');
    app.toast('Project saved');
  } catch (e) {
    app.toast(`Save failed: ${errorMessage(e)}`, 'error');
  }
}

export function safeName(s: string) {
  return s.replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '') || 'model';
}

// ---------------------------------------------------------------------------------- dialogs

/**
 * @param centerIn element to center the dialog on; defaults to the 3D viewport, which keeps dialogs clear of the
 *                 panels (and of the toasts, which move to the window corner while a dialog is open)
 */
export function openModal(
  title: string,
  body: HTMLElement,
  footer: HTMLElement[] = [],
  onClose?: () => void,
  centerIn: HTMLElement | null = document.getElementById('viewport-wrap'),
): () => void {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    onClose?.();
  };
  const place = () => {
    if (!centerIn) return;
    const r = centerIn.getBoundingClientRect();
    if (!r.width || !r.height) return; // not laid out (hidden window): stay window-centered
    Object.assign(modal.style, {
      position: 'fixed',
      left: `${r.left + r.width / 2}px`,
      top: `${r.top + r.height / 2}px`,
      transform: 'translate(-50%, -50%)',
      maxHeight: `${Math.max(240, r.height - 24)}px`,
    });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const modal = h(
    'div',
    { class: 'modal', role: 'dialog', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', title: 'Close', onclick: close, html: ICONS.close })),
    h('div', { class: 'modal-body' }, body),
    footer.length ? h('div', { class: 'modal-foot' }, ...footer) : null,
  );
  const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (e: MouseEvent) => e.target === backdrop && close() }, modal);
  place();
  window.addEventListener('resize', place);
  window.addEventListener('keydown', onKey, true);
  document.body.append(backdrop);
  return close;
}

/** Toasts and returns true while a bake, load or stroke is running (actions should wait for it). */
export function busyWarning(app: App): boolean {
  if (!app.busy && !app.painter.isPainting) return false;
  app.toast('Wait for the current operation to finish.', 'warn');
  return true;
}

export function exportDialog(app: App) {
  if (!app.mesh) return app.toast('Load a mesh first.', 'warn');
  if (busyWarning(app)) return;
  let preset = EXPORT_PRESETS[1];
  let normal: 'opengl' | 'directx' = preset.normal;
  let baseName = safeName(app.mesh.name);
  let format: ExportFormat = 'png8';
  const normalSel = h('div');
  const info = h('div', { class: 'dim small' });
  const mapsList = h('ul', { class: 'export-maps' });
  const refresh = () => {
    normalSel.replaceChildren(
      selectField('Normal map', [['opengl', 'OpenGL (Y+)'], ['directx', 'DirectX (Y−)']] as const, normal, (v) => (normal = v)),
    );
    const ext = format === 'exr' ? 'exr' : 'png';
    const sizes = app.sets.map((s) => `${app.sets.length > 1 ? `${s.info.name}: ` : ''}${s.texSize}×${s.texSize}`).join(' · ');
    info.textContent = `${sizes} — ${EXPORT_FORMATS.find((f) => f[0] === format)![1]}, UV padding applied.`;
    const prefixes = exportPrefixes(baseName, app.sets.map((s) => s.info.name));
    mapsList.replaceChildren(
      ...prefixes.flatMap((pre) =>
        preset.maps.map((m) =>
          h(
            'li',
            {},
            `${pre}_${m.suffix}.${ext}`,
            h(
              'span',
              { class: 'dim' },
              format === 'exr'
                ? m.optional === 'map'
                  ? ' · RGBA, only if used'
                  : ' · RGBA'
                : m.optional === 'map'
                ? ' · RGB, only if used'
                : m.optional === 'alpha'
                  ? ' · RGB (+ opacity alpha if used)'
                  : ` · ${['', 'grey', '', 'RGB', 'RGBA'][m.channels.length]}`,
            ),
          ),
        ),
      ),
    );
  };
  const nameInput = h('input', { type: 'text', value: baseName, oninput: () => ((baseName = safeName(nameInput.value)), refresh()) }) as HTMLInputElement;
  const body = h(
    'div',
    { class: 'form' },
    selectField('Preset', EXPORT_PRESETS.map((p) => [p.id, p.name] as const), preset.id, (id) => {
      preset = EXPORT_PRESETS.find((p) => p.id === id)!;
      normal = preset.normal;
      refresh();
    }),
    h('div', { class: 'field' }, h('label', {}, 'File prefix'), nameInput),
    normalSel,
    selectField('Format', EXPORT_FORMATS, format, (v) => ((format = v), refresh())),
    info,
    mapsList,
  );
  refresh();
  const doTextures = h('button', { class: 'btn primary' }, 'Export Textures (.zip)');
  const doGlb = h('button', { class: 'btn' }, 'Export Textured GLB');
  const close = openModal('Export', body, [doGlb, doTextures]);
  doTextures.addEventListener('click', async () => {
    if (busyWarning(app)) return;
    try {
      const zip = await app.exporter.exportTextures(exportSets(app), app.mesh!, { preset, normal, baseName, format });
      downloadBlob(zip as BlobPart, `${baseName}_textures.zip`, 'application/zip');
      app.toast('Textures exported');
      close();
    } catch (e) {
      app.toast(`Export failed: ${errorMessage(e)}`, 'error');
    }
  });
  doGlb.addEventListener('click', async () => {
    if (busyWarning(app)) return;
    try {
      const glb = await app.exporter.exportGLB(exportSets(app), app.mesh!);
      downloadBlob(glb, `${baseName}.glb`, 'model/gltf-binary');
      app.toast('GLB exported');
      close();
    } catch (e) {
      app.toast(`GLB export failed: ${errorMessage(e)}`, 'error');
    }
  });
}

function exportSets(app: App) {
  return app.sets.map((s) => ({ name: s.info.name, final: s.compositor.final }));
}

export function bakeDialog(app: App) {
  if (!app.mesh) return app.toast('Load a mesh first.', 'warn');
  if (busyWarning(app)) return;
  const s = { ...app.bake };
  const hpLabel = h('span', { class: 'hp-name' });
  const hpRemove = h('button', { class: 'btn small' }, 'Remove');
  const hpLoad = h('button', { class: 'btn small' }, 'Load…');
  const cage = h(
    'div',
    {},
    slider('Cage front (% of size)', {
      value: s.frontDistance * 100,
      min: 0,
      max: 20,
      step: 0.1,
      title: 'How far outside the low poly the projection rays start',
      onInput: (v) => (s.frontDistance = v / 100),
    }),
    slider('Cage back (% of size)', {
      value: s.backDistance * 100,
      min: 0,
      max: 20,
      step: 0.1,
      title: 'How far inside the low poly the high poly may still be found',
      onInput: (v) => (s.backDistance = v / 100),
    }),
  );
  const showHighPoly = () => {
    const hp = app.highPoly;
    hpLabel.textContent = hp ? `${hp.name} · ${hp.triangles.toLocaleString()} triangles` : 'None — maps come from the low poly';
    hpLabel.classList.toggle('dim', !hp);
    hpRemove.style.display = hp ? '' : 'none';
    cage.style.display = hp ? '' : 'none';
  };
  hpLoad.addEventListener('click', async () => {
    if (busyWarning(app)) return;
    const files = await pickFiles(MODEL_ACCEPT, true);
    if (!files.length) return;
    hpLabel.textContent = 'Loading…';
    try {
      const model = await resolveModel(app, fromFiles(files));
      if (model) await app.setHighPoly({ name: model.name, bytes: model.bytes.slice().buffer });
    } catch (e) {
      app.toast(`Could not load high poly: ${errorMessage(e)}`, 'error');
    }
    showHighPoly();
  });
  hpRemove.addEventListener('click', async () => {
    if (busyWarning(app)) return;
    await app.setHighPoly(null);
    showHighPoly();
  });
  showHighPoly();
  const body = h(
    'div',
    { class: 'form' },
    h('p', { class: 'dim small' }, 'Mesh maps drive the smart masks (edge wear, dirt, dust, gradients) and the base normal map.'),
    h('div', { class: 'field hp-row' }, h('label', {}, 'High poly'), hpLabel, hpLoad, hpRemove),
    h(
      'p',
      { class: 'dim small' },
      'With a high poly (same position and units as the low poly), its detail is projected into the normal, AO and curvature maps. Raise the cage distances if parts come out flat.',
    ),
    cage,
    selectField('AO samples', [[32, '32 (fast)'], [64, '64'], [128, '128'], [256, '256'], [512, '512 (slow)']] as const, s.aoSamples, (v) => (s.aoSamples = v)),
    slider('AO max distance', { value: s.aoDistance, min: 0.05, max: 2, step: 0.01, onInput: (v) => (s.aoDistance = v) }),
    slider('Curvature gain', { value: s.curvatureGain, min: 0.1, max: 4, step: 0.05, onInput: (v) => (s.curvatureGain = v) }),
    slider('Sharp edge angle', {
      value: s.sharpAngle,
      min: 5,
      max: 90,
      step: 1,
      digits: 0,
      title: 'Faces meeting at more than this angle form a hard edge (like auto smooth). Hard edges get crisp, even-width edge masks.',
      onInput: (v) => (s.sharpAngle = v),
    }),
    slider('Edge width (% of size)', {
      value: s.edgeWidth * 100,
      min: 0.2,
      max: 10,
      step: 0.1,
      title: 'How far edge masks (edge wear, ink outlines, crease dirt) can reach from a hard edge',
      onInput: (v) => (s.edgeWidth = v / 100),
    }),
  );
  const go = h('button', { class: 'btn primary' }, 'Bake');
  const close = openModal('Bake Mesh Maps', body, [go]);
  go.addEventListener('click', async () => {
    if (busyWarning(app)) return;
    close();
    app.bake = s;
    if (await app.rebake()) app.toast('Mesh maps baked');
  });
}

export function shortcutsDialog() {
  const rows: [string, string][] = [
    ['Left mouse', 'Paint'],
    ['Alt + Left / Middle mouse', 'Orbit'],
    ['Right mouse / Shift + Middle', 'Pan'],
    ['Wheel', 'Zoom'],
    ['B / E', 'Paint / Erase tool'],
    ['Ctrl + Right mouse drag', 'Brush size (left/right) or hardness (up/down)'],
    ['[ and ]', 'Brush size'],
    ['Shift + [ and ]', 'Brush hardness'],
    ['X', 'Swap mask paint value (black/white)'],
    ['S (hold)', 'Stencil: drag to move, wheel to scale, Shift+wheel to rotate'],
    ['M', 'Toggle painting layer content / mask'],
    ['C', 'Cycle viewport channel'],
    ['F', 'Frame model (UV square in the 2D view)'],
    ['U', 'Toggle 3D / 2D UV view'],
    ['Ctrl + Z / Ctrl + Shift + Z', 'Undo / Redo'],
    ['Ctrl + G', 'Put the selected layer in a new folder'],
    ['Ctrl + O', 'Open mesh'],
    ['Ctrl + S', 'Save project (download .mfp)'],
    ['Ctrl + Alt + S', 'Save version (iterative save)'],
    ['Ctrl + E', 'Export'],
  ];
  openModal(
    'Shortcuts',
    h('table', { class: 'shortcuts' }, ...rows.map(([k, v]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, v)))),
  );
}

export function aboutDialog() {
  openModal(
    'About Moonfang 3D Textures',
    h(
      'div',
      { class: 'form' },
      h('p', {}, h('strong', {}, `Moonfang 3D Textures ${VERSION_LABEL}`)),
      h('p', {}, 'Moonfang is a free, open source (MIT) 3D texture painting tool for game assets.'),
      h(
        'ul',
        {},
        h('li', {}, 'Projection painting across all PBR channels at once'),
        h('li', {}, 'Paint & fill layers with masks and blend modes'),
        h('li', {}, 'Baked mesh maps: ambient occlusion, curvature, position, world normal'),
        h('li', {}, 'Procedural smart masks and smart materials'),
        h('li', {}, 'Export to Unreal, Unity, Godot/glTF or textured GLB'),
      ),
      h('p', { class: 'dim small' }, 'Built with three.js, three-mesh-bvh and fflate (MIT; see THIRD_PARTY_NOTICES.md).'),
      h('p', { class: 'dim small' }, 'Your work never leaves your computer: no accounts, no uploads, no analytics. The only network request is the update check.'),
      h('p', {}, h('a', { href: REPO_URL, target: '_blank', rel: 'noopener' }, 'Source code on GitHub'), ' · ', h('a', { href: KOFI_URL, target: '_blank', rel: 'noopener' }, 'Support on Ko-fi')),
    ),
  );
}

export function openKofi() {
  window.open(KOFI_URL, '_blank', 'noopener');
}

export function displaySettings(app: App): HTMLElement {
  const v = app.viewport;
  return h(
    'div',
    {},
    slider('Normal strength', { value: app.composite.normalStrength, min: 0, max: 4, step: 0.05, onInput: (x) => ((app.composite.normalStrength = x), app.invalidate(true)) }),
    slider('AO strength', { value: app.composite.aoStrength, min: 0, max: 1, step: 0.01, onInput: (x) => ((app.composite.aoStrength = x), app.invalidate(true)) }),
    slider('Exposure', { value: v.renderer.toneMappingExposure, min: 0.1, max: 3, step: 0.01, onInput: (x) => v.setExposure(x) }),
    slider('Env rotation', { value: 0, min: -180, max: 180, step: 1, onInput: (x) => v.setEnvRotation(x) }),
    checkbox('Show environment background', v.showBackground, (x) => (v.showBackground = x)),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'btn',
          onclick: async () => {
            const f = await pickFile('.hdr');
            if (!f) return;
            try {
              await v.loadHDR(f);
              app.toast(`Environment: ${f.name}`);
            } catch (e) {
              app.toast(`Could not load HDR: ${errorMessage(e)}`, 'error');
            }
          },
        },
        'Load HDRI…',
      ),
      h('button', { class: 'btn', onclick: () => bakeDialog(app) }, 'Bake mesh maps…'),
    ),
  );
}

// ---------------------------------------------------------------------------------- user library

const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.webp,.avif';

export async function importTextureSetAction(app: App, files?: File[]) {
  files ??= await pickFiles(IMAGE_ACCEPT, true);
  if (!files.length) return;
  try {
    await app.importTextureSet(files);
  } catch (e) {
    app.toast(`Could not import texture set: ${errorMessage(e)}`, 'error');
  }
}

export async function importLibraryAction(app: App, file?: File | null) {
  file ??= await pickFile('.mflib,.zip,.json');
  if (!file) return;
  try {
    const r = await app.library.importFile(file.name, new Uint8Array(await file.arrayBuffer()));
    app.toast(`Imported ${r.materials} material(s) and ${r.smart} smart material(s) from ${file.name}`);
  } catch (e) {
    app.toast(`Could not import library: ${errorMessage(e)}`, 'error');
  }
}

export function exportLibraryAction(app: App) {
  const lib = app.library;
  if (!lib.materials.length && !lib.smart.length) return app.toast('Your library is empty — import or save a material first.', 'warn');
  downloadBlob(lib.exportFile() as BlobPart, 'my_materials.mflib', 'application/zip');
  app.toast(`Exported ${lib.materials.length} material(s) and ${lib.smart.length} smart material(s)`);
}

export function saveMaterialDialog(app: App) {
  const l = app.selected;
  if (!l || l.kind !== 'fill') return app.toast('Select a fill layer to save its material.', 'warn');
  const input = h('input', { type: 'text', value: l.name.split(' · ').pop() }) as HTMLInputElement;
  const go = h('button', { class: 'btn primary' }, 'Save');
  const close = openModal('Save Material', h('div', { class: 'form' }, h('div', { class: 'field' }, h('label', {}, 'Name'), input)), [go]);
  const save = () => {
    app.saveFillAsMaterial(l.id, input.value.trim() || l.name);
    close();
  };
  go.addEventListener('click', save);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && save());
  input.focus();
  input.select();
}

export function saveSmartMaterialDialog(app: App) {
  const fills = app.allLayers.filter((l) => l.kind === 'fill');
  if (!fills.length) return app.toast('Smart materials are made from fill layers. Add some fill layers first.', 'warn');
  // Preselect the fill layers of the selected folder (e.g. one added from a smart material), else all of them.
  const sel = app.selected;
  const group = sel?.kind === 'group' ? sel : null;
  const inGroup = new Set(group ? [...walkLayers(group.children)].map((l) => l.id) : []);
  const picked = new Set(fills.filter((l) => !group || inGroup.has(l.id)).map((l) => l.id));
  const name = h('input', { type: 'text', value: group ? `${group.name} (custom)` : 'My Smart Material' }) as HTMLInputElement;
  const list = h(
    'div',
    { class: 'layer-pick' },
    ...[...fills].reverse().map((l) =>
      checkbox(
        `${l.name}${l.mask?.generator ? ` — ${l.mask.generator.type} mask` : ''}`,
        picked.has(l.id),
        (v) => (v ? picked.add(l.id) : picked.delete(l.id)),
      ),
    ),
  );
  const body = h(
    'div',
    { class: 'form' },
    h('div', { class: 'field' }, h('label', {}, 'Name'), name),
    h('div', { class: 'dim small' }, 'Fill layers (top first) with their settings and generator masks. Paint layers and hand-painted mask strokes are tied to this mesh’s UVs and are not included.'),
    list,
  );
  const go = h('button', { class: 'btn primary' }, 'Save Smart Material');
  const close = openModal('Save as Smart Material', body, [go]);
  go.addEventListener('click', () => {
    if (!picked.size) return app.toast('Pick at least one layer.', 'warn');
    if (app.saveLayersAsSmartMaterial([...picked], name.value.trim() || 'My Smart Material')) close();
  });
}
