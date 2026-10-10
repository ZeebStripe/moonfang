import type { App } from '../app';
import { downloadBlob, EXPORT_PRESETS } from '../engine/exporter';
import { walkLayers } from '../engine/layers';
import { loadDemoMesh, loadMeshFile, type DemoMeshId } from '../engine/meshLoader';
import { checkbox, h, pickFile, pickFiles, selectField, slider } from './dom';
import { ICONS } from './icons';

export function errorMessage(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

export async function openMeshDialog(app: App) {
  const file = await pickFile('.glb,.gltf,.obj,.fbx');
  if (file) await openMeshFile(app, file);
}

export async function openMeshFile(app: App, file: File) {
  if (app.busy) return;
  try {
    const mesh = await loadMeshFile(file.name, await file.arrayBuffer());
    const keep = app.mesh && app.allLayers.length > 2 && confirm('Keep the current layers on the new mesh? (Cancel starts a fresh layer stack)');
    await app.openMesh(mesh, !keep);
    app.toast(`Loaded ${file.name}`);
  } catch (e) {
    app.toast(`Could not load mesh: ${errorMessage(e)}`, 'error');
  }
}

export async function openDemo(app: App, id: DemoMeshId) {
  if (app.busy) return;
  await app.openMesh(loadDemoMesh(id), true);
}

export async function openProjectDialog(app: App) {
  const file = await pickFile('.opp,.zip');
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
    downloadBlob(data as BlobPart, `${safeName(app.mesh.name)}.opp`, 'application/zip');
    app.toast('Project saved');
  } catch (e) {
    app.toast(`Save failed: ${errorMessage(e)}`, 'error');
  }
}

export function safeName(s: string) {
  return s.replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '') || 'model';
}

// ---------------------------------------------------------------------------------- dialogs

export function openModal(title: string, body: HTMLElement, footer: HTMLElement[] = [], onClose?: () => void): () => void {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    window.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const backdrop = h(
    'div',
    { class: 'modal-backdrop', onmousedown: (e: MouseEvent) => e.target === backdrop && close() },
    h(
      'div',
      { class: 'modal', role: 'dialog', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', title: 'Close', onclick: close, html: ICONS.close })),
      h('div', { class: 'modal-body' }, body),
      footer.length ? h('div', { class: 'modal-foot' }, ...footer) : null,
    ),
  );
  window.addEventListener('keydown', onKey, true);
  document.body.append(backdrop);
  return close;
}

export function exportDialog(app: App) {
  if (!app.mesh) return app.toast('Load a mesh first.', 'warn');
  let preset = EXPORT_PRESETS[1];
  let normal: 'opengl' | 'directx' = preset.normal;
  let baseName = safeName(app.mesh.name);
  const normalSel = h('div');
  const mapsList = h('ul', { class: 'export-maps' });
  const refresh = () => {
    normalSel.replaceChildren(
      selectField('Normal map', [['opengl', 'OpenGL (Y+)'], ['directx', 'DirectX (Y−)']] as const, normal, (v) => (normal = v)),
    );
    mapsList.replaceChildren(...preset.maps.map((m) => h('li', {}, `${baseName}_${m.suffix}.png`, h('span', { class: 'dim' }, ` · ${['', 'grey', '', 'RGB', 'RGBA'][m.channels.length]}`))));
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
    h('div', { class: 'dim small' }, `Resolution ${app.texSize}×${app.texSize}, 8-bit PNG, UV padding applied.`),
    mapsList,
  );
  refresh();
  const doTextures = h('button', { class: 'btn primary' }, 'Export Textures (.zip)');
  const doGlb = h('button', { class: 'btn' }, 'Export Textured GLB');
  const close = openModal('Export', body, [doGlb, doTextures]);
  doTextures.addEventListener('click', () => {
    try {
      const zip = app.exporter.exportTextures(app.compositor.final, app.mesh!, { preset, normal, baseName });
      downloadBlob(zip as BlobPart, `${baseName}_textures.zip`, 'application/zip');
      app.toast('Textures exported');
      close();
    } catch (e) {
      app.toast(`Export failed: ${errorMessage(e)}`, 'error');
    }
  });
  doGlb.addEventListener('click', async () => {
    try {
      const glb = await app.exporter.exportGLB(app.compositor.final, app.mesh!);
      downloadBlob(glb, `${baseName}.glb`, 'model/gltf-binary');
      app.toast('GLB exported');
      close();
    } catch (e) {
      app.toast(`GLB export failed: ${errorMessage(e)}`, 'error');
    }
  });
}

export function bakeDialog(app: App) {
  if (!app.mesh) return app.toast('Load a mesh first.', 'warn');
  const s = { ...app.bake };
  const body = h(
    'div',
    { class: 'form' },
    h('p', { class: 'dim small' }, 'Mesh maps drive the smart masks (edge wear, dirt, dust, gradients). They are baked from the low-poly mesh itself.'),
    selectField('AO samples', [[32, '32 (fast)'], [64, '64'], [128, '128'], [256, '256'], [512, '512 (slow)']] as const, s.aoSamples, (v) => (s.aoSamples = v)),
    slider('AO max distance', { value: s.aoDistance, min: 0.05, max: 2, step: 0.01, onInput: (v) => (s.aoDistance = v) }),
    slider('Curvature gain', { value: s.curvatureGain, min: 0.1, max: 4, step: 0.05, onInput: (v) => (s.curvatureGain = v) }),
  );
  const go = h('button', { class: 'btn primary' }, 'Bake');
  const close = openModal('Bake Mesh Maps', body, [go]);
  go.addEventListener('click', async () => {
    close();
    app.bake = s;
    await app.rebake();
    app.toast('Mesh maps baked');
  });
}

export function shortcutsDialog() {
  const rows: [string, string][] = [
    ['Left mouse', 'Paint'],
    ['Alt + Left / Middle mouse', 'Orbit'],
    ['Right mouse / Shift + Middle', 'Pan'],
    ['Wheel', 'Zoom'],
    ['B / E', 'Paint / Erase tool'],
    ['[ and ]', 'Brush size'],
    ['Shift + [ and ]', 'Brush hardness'],
    ['X', 'Swap mask paint value (black/white)'],
    ['S (hold)', 'Stencil: drag to move, wheel to scale, Shift+wheel to rotate'],
    ['M', 'Toggle painting layer content / mask'],
    ['C', 'Cycle viewport channel'],
    ['F', 'Frame model'],
    ['Ctrl + Z / Ctrl + Shift + Z', 'Undo / Redo'],
    ['Ctrl + G', 'Put the selected layer in a new folder'],
    ['Ctrl + O', 'Open mesh'],
    ['Ctrl + S', 'Save project'],
    ['Ctrl + E', 'Export'],
  ];
  openModal(
    'Shortcuts',
    h('table', { class: 'shortcuts' }, ...rows.map(([k, v]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, v)))),
  );
}

export function aboutDialog() {
  openModal(
    'About Open Painter',
    h(
      'div',
      { class: 'form' },
      h('p', {}, 'Open Painter is a free, open source (MIT) 3D texture painting tool for game assets.'),
      h(
        'ul',
        {},
        h('li', {}, 'Projection painting across all PBR channels at once'),
        h('li', {}, 'Paint & fill layers with masks and blend modes'),
        h('li', {}, 'Baked mesh maps: ambient occlusion, curvature, position, world normal'),
        h('li', {}, 'Procedural smart masks and smart materials'),
        h('li', {}, 'Export to Unreal, Unity, Godot/glTF or textured GLB'),
      ),
      h('p', { class: 'dim small' }, 'Built with three.js and WebGL2.'),
    ),
  );
}

export function displaySettings(app: App): HTMLElement {
  const v = app.viewport;
  return h(
    'div',
    {},
    slider('Normal strength', { value: app.composite.normalStrength, min: 0, max: 4, step: 0.05, onInput: (x) => ((app.composite.normalStrength = x), app.invalidate()) }),
    slider('AO strength', { value: app.composite.aoStrength, min: 0, max: 1, step: 0.01, onInput: (x) => ((app.composite.aoStrength = x), app.invalidate()) }),
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
  file ??= await pickFile('.oplib,.zip,.json');
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
  downloadBlob(lib.exportFile() as BlobPart, 'my_materials.oplib', 'application/zip');
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
