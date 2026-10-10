import './style.css';
import { App } from './app';
import { loadDemoMesh } from './engine/meshLoader';
import { mountDropZone, mountProgress, mountStatusbar, mountToasts, mountToolbar, mountTopbar } from './ui/chrome';
import { bindViewportInput } from './ui/input';
import { mountLayersPanel } from './ui/layersPanel';
import { mountPropsPanel } from './ui/propsPanel';
import { mountShelf } from './ui/shelf';

const $ = (id: string) => document.getElementById(id)!;

async function boot() {
  let app: App;
  try {
    app = new App($('viewport') as HTMLCanvasElement);
  } catch (e) {
    const fatal = $('fatal');
    fatal.hidden = false;
    fatal.textContent = `Open Painter needs WebGL2 with float render targets. ${e instanceof Error ? e.message : e}`;
    return;
  }
  const wrap = $('viewport-wrap');
  const resize = () => app.viewport.resize();
  new ResizeObserver(resize).observe(wrap);
  resize();

  mountToasts(app);
  mountProgress(app);
  mountTopbar(app, $('topbar'));
  mountToolbar(app, $('toolbar'));
  mountLayersPanel(app, $('layers-panel'));
  mountPropsPanel(app, $('props-panel'));
  mountShelf(app, $('shelf'));
  mountStatusbar(app, $('statusbar'));
  mountDropZone(app, wrap);
  bindViewportInput(app, wrap, $('brush-cursor'));

  await app.openMesh(loadDemoMesh('roundedCube'));
  // Exposed for debugging from the devtools console.
  (window as unknown as { app: App }).app = app;
}

void boot();
