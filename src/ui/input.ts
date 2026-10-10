import type { App } from '../app';
import type { Stamp } from '../engine/painter';
import { VIEW_MODES } from '../engine/viewport';
import { exportDialog, openMeshDialog, saveProjectAction } from './actions';

export function bindViewportInput(app: App, wrap: HTMLElement, cursor: HTMLElement) {
  const canvas = app.viewport.canvas;
  let painting = false;
  let pointerId = -1;
  let last: { x: number; y: number } | null = null;
  let carry = 0;
  let lastToast = 0;
  let hover = false;
  let altDown = false;

  const dpr = () => app.renderer.getPixelRatio();
  const toBuffer = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * dpr(), y: (r.height - (e.clientY - r.top)) * dpr() };
  };
  const pressureOf = (e: PointerEvent) => (e.pointerType === 'pen' ? Math.max(0.02, e.pressure) : 1);

  function stampsTo(p: { x: number; y: number }, pressure: number): Stamp[] {
    const b = app.brush;
    const radius = b.size * dpr() * (b.pressureSize ? 0.15 + 0.85 * pressure : 1);
    const a = b.pressureOpacity ? pressure : 1;
    const out: Stamp[] = [];
    if (!last) {
      out.push({ x: p.x, y: p.y, r: radius, a });
      last = p;
      carry = 0;
      return out;
    }
    const spacing = Math.max(1, b.spacing * radius);
    const dx = p.x - last.x;
    const dy = p.y - last.y;
    const seg = Math.hypot(dx, dy);
    let s = spacing - carry;
    while (s <= seg) {
      const t = s / seg;
      out.push({ x: last.x + dx * t, y: last.y + dy * t, r: radius, a });
      s += spacing;
    }
    carry = seg - (s - spacing);
    last = p;
    return out;
  }

  function updateCursor(e?: PointerEvent) {
    const show = hover && !altDown && !!app.mesh;
    cursor.style.display = show ? 'block' : 'none';
    if (!e) return;
    const r = wrap.getBoundingClientRect();
    const d = app.brush.size * 2;
    Object.assign(cursor.style, { width: `${d}px`, height: `${d}px`, left: `${e.clientX - r.left - d / 2}px`, top: `${e.clientY - r.top - d / 2}px` });
    cursor.className = `brush-cursor ${app.tool} ${app.part === 'mask' ? 'mask' : ''}`;
  }

  // Capture phase so a painting click never reaches OrbitControls.
  wrap.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0 || e.altKey || painting) return;
      if (e.target !== canvas) return;
      e.stopPropagation();
      e.preventDefault();
      const reason = app.paintBlockedReason();
      if (reason) {
        if (performance.now() - lastToast > 1500) app.toast(reason, 'warn');
        lastToast = performance.now();
        return;
      }
      if (!app.beginStroke()) return;
      painting = true;
      pointerId = e.pointerId;
      canvas.setPointerCapture(e.pointerId);
      last = null;
      app.queueStamps(stampsTo(toBuffer(e), pressureOf(e)));
    },
    true,
  );

  canvas.addEventListener('pointermove', (e) => {
    hover = true;
    updateCursor(e);
    if (!painting || e.pointerId !== pointerId) return;
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
    for (const ev of events.length ? events : [e]) app.queueStamps(stampsTo(toBuffer(ev), pressureOf(ev)));
  });

  const finish = (e: PointerEvent) => {
    if (!painting || e.pointerId !== pointerId) return;
    painting = false;
    pointerId = -1;
    last = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    app.endStroke();
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  canvas.addEventListener('pointerenter', () => ((hover = true), updateCursor()));
  canvas.addEventListener('pointerleave', () => ((hover = false), updateCursor()));
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  app.on((k) => {
    if (k === 'tool' || k === 'selection') {
      const d = app.brush.size * 2;
      const left = parseFloat(cursor.style.left || '0') + parseFloat(cursor.style.width || '0') / 2;
      const top = parseFloat(cursor.style.top || '0') + parseFloat(cursor.style.height || '0') / 2;
      Object.assign(cursor.style, { width: `${d}px`, height: `${d}px`, left: `${left - d / 2}px`, top: `${top - d / 2}px` });
      cursor.className = `brush-cursor ${app.tool} ${app.part === 'mask' ? 'mask' : ''}`;
    }
  });

  // ------------------------------------------------------------------ keyboard
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Alt') {
      altDown = true;
      updateCursor();
      e.preventDefault();
    }
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (document.querySelector('.modal-backdrop')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (ctrl) {
      if (key === 'z' && !e.shiftKey) app.undo();
      else if ((key === 'z' && e.shiftKey) || key === 'y') app.redo();
      else if (key === 's') saveProjectAction(app);
      else if (key === 'e') exportDialog(app);
      else if (key === 'o') void openMeshDialog(app);
      else return;
      e.preventDefault();
      return;
    }
    const b = app.brush;
    switch (e.key) {
      case '[':
      case '{':
        if (e.shiftKey) b.hardness = Math.max(0, +(b.hardness - 0.1).toFixed(2));
        else b.size = Math.max(1, Math.round(b.size / 1.15));
        app.emit('tool');
        app.emit('brush');
        break;
      case ']':
      case '}':
        if (e.shiftKey) b.hardness = Math.min(1, +(b.hardness + 0.1).toFixed(2));
        else b.size = Math.min(400, Math.round(b.size * 1.15 + 1));
        app.emit('tool');
        app.emit('brush');
        break;
      default:
        switch (key) {
          case 'b':
            app.setTool('paint');
            break;
          case 'e':
            app.setTool('erase');
            break;
          case 'x':
            b.maskValue = 1 - b.maskValue;
            app.emit('brush');
            app.toast(`Mask value: ${b.maskValue >= 0.5 ? 'white (reveal)' : 'black (hide)'}`);
            break;
          case 'm': {
            const l = app.selected;
            if (l?.mask) app.select(l.id, app.part === 'mask' ? 'content' : 'mask');
            break;
          }
          case 'f':
            app.viewport.frame();
            break;
          case 'c': {
            const modes = VIEW_MODES.map((m) => m[0]);
            const i = modes.indexOf(app.viewport.mode);
            const next = modes[(i + (e.shiftKey ? modes.length - 1 : 1)) % modes.length];
            app.viewport.setMode(next);
            app.invalidate();
            app.emit('view');
            break;
          }
          default:
            return;
        }
    }
    e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Alt') {
      altDown = false;
      updateCursor();
    }
  });
  window.addEventListener('blur', () => {
    altDown = false;
  });
}
