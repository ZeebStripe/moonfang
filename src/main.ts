import './style.css';
import { App } from './app';
import { loadDemoMesh } from './engine/meshLoader';
import { deviceNotice, mountDropZone, mountGpuLossDialog, mountProgress, mountStatusbar, mountToasts, mountToolbar, mountTopbar } from './ui/chrome';
import { setupAutosave } from './ui/autosave';
import { reportBug } from './ui/report';
import { checkForUpdates } from './ui/updates';
import { installErrorCapture, onErrorRecorded } from './errors';
import { bindViewportInput } from './ui/input';
import { mountStencilOverlay, mountSymmetryToggles } from './ui/brushUI';
import { mountLayersPanel } from './ui/layersPanel';
import { mountPropsPanel } from './ui/propsPanel';
import { mountShelf } from './ui/shelf';

const $ = (id: string) => document.getElementById(id)!;

// First, so errors during start-up are recorded for bug reports too.
installErrorCapture();

async function boot() {
  let app: App;
  try {
    app = new App($('viewport') as HTMLCanvasElement);
  } catch (e) {
    const fatal = $('fatal');
    fatal.hidden = false;
    fatal.textContent = `Moonfang needs WebGL2 with float render targets. ${e instanceof Error ? e.message : e}`;
    return;
  }
  const wrap = $('viewport-wrap');
  const resize = () => app.viewport.resize();
  new ResizeObserver(resize).observe(wrap);
  resize();

  mountToasts(app);
  // Offer a report when something breaks (at most once every two minutes, so a burst of errors is one prompt).
  let lastErrorPrompt = 0;
  onErrorRecorded(() => {
    if (Date.now() - lastErrorPrompt < 120_000) return;
    lastErrorPrompt = Date.now();
    app.toast('Something went wrong. A bug report would help fix it.', 'error', { label: 'Report…', run: () => reportBug(app) });
  });
  mountGpuLossDialog(app);
  mountProgress(app);
  mountTopbar(app, $('topbar'));
  mountToolbar(app, $('toolbar'));
  mountLayersPanel(app, $('layers-panel'));
  mountPropsPanel(app, $('props-panel'));
  mountShelf(app, $('shelf'));
  mountStatusbar(app, $('statusbar'));
  mountDropZone(app, wrap);
  bindViewportInput(app, wrap, $('brush-cursor'));
  mountStencilOverlay(app, wrap);
  mountSymmetryToggles(app, wrap);

  await deviceNotice();
  // Offer to restore the last autosave first; otherwise start with the demo mesh.
  if (!(await setupAutosave(app))) await app.openMesh(loadDemoMesh('roundedCube'));
  void checkForUpdates(app);
  // Exposed for debugging from the devtools console.
  (window as unknown as { app: App }).app = app;
}

void boot();
