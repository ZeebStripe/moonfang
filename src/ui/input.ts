import type { App } from '../app';
import type { Stamp } from '../engine/painter';
import { VIEW_MODES } from '../engine/viewport';
import { FACE_MODES } from '../engine/faceSelect';
import { exportDialog, openMeshDialog, saveProjectAction } from './actions';
import { saveVersionDialog } from './saves';
import { h } from './dom';

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

  let smooth: { x: number; y: number } | null = null;
  let lastDir = 0;

  /** One stamp with the brush dynamics (size/angle/opacity jitter, scatter, follow-stroke rotation) applied. */
  function stamp(x: number, y: number, radius: number, alpha: number, dir: number): Stamp {
    const b = app.brush;
    const r = radius * (1 - b.sizeJitter * Math.random());
    if (b.scatter > 0) {
      const ang = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * b.scatter * radius;
      x += Math.cos(ang) * d;
      y += Math.sin(ang) * d;
    }
    const rot = (b.angle * Math.PI) / 180 + (b.followStroke ? dir : 0) + b.angleJitter * Math.PI * (Math.random() * 2 - 1);
    return { x, y, r, a: alpha * (1 - b.opacityJitter * Math.random()), rot };
  }

  function stampsTo(raw: { x: number; y: number }, pressure: number): Stamp[] {
    const b = app.brush;
    // Lazy mouse: the brush trails the pointer.
    let p = raw;
    if (b.smoothing > 0 && smooth) {
      const k = 1 - Math.min(b.smoothing, 0.95);
      smooth = { x: smooth.x + (raw.x - smooth.x) * k, y: smooth.y + (raw.y - smooth.y) * k };
      p = smooth;
    } else smooth = raw;
    const radius = b.size * dpr() * (b.pressureSize ? 0.15 + 0.85 * pressure : 1);
    const a = b.pressureOpacity ? pressure : 1;
    const out: Stamp[] = [];
    if (!last) {
      out.push(stamp(p.x, p.y, radius, a, lastDir));
      last = p;
      carry = 0;
      return out;
    }
    const spacing = Math.max(1, b.spacing * radius);
    const dx = p.x - last.x;
    const dy = p.y - last.y;
    const seg = Math.hypot(dx, dy);
    if (seg > 0.5) lastDir = Math.atan2(dy, dx);
    let s = spacing - carry;
    while (s <= seg) {
      const t = s / seg;
      out.push(stamp(last.x + dx * t, last.y + dy * t, radius, a, lastDir));
      s += spacing;
    }
    carry = seg - (s - spacing);
    last = p;
    return out;
  }

  // ------------------------------------------------------------------ stencil (hold S)
  let stencilKey = false;
  let stencilDrag: { x: number; y: number; sx: number; sy: number } | null = null;
  const stencilReady = () => !!app.brush.stencil.imageId && app.brush.stencil.enabled;

  wrap.addEventListener(
    'pointerdown',
    (e) => {
      if (!stencilKey || !stencilReady() || e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const st = app.brush.stencil;
      stencilDrag = { x: e.clientX, y: e.clientY, sx: st.x, sy: st.y };
      canvas.setPointerCapture(e.pointerId);
    },
    true,
  );
  canvas.addEventListener('pointermove', (e) => {
    if (!stencilDrag) return;
    const st = app.brush.stencil;
    st.x = stencilDrag.sx + e.clientX - stencilDrag.x;
    st.y = stencilDrag.sy + e.clientY - stencilDrag.y;
    app.emit('stencil');
  });
  canvas.addEventListener('pointerup', () => (stencilDrag = null));
  wrap.addEventListener(
    'wheel',
    (e) => {
      if (!stencilKey || !stencilReady()) return;
      e.preventDefault();
      e.stopPropagation();
      const st = app.brush.stencil;
      if (e.shiftKey) st.rotation = ((st.rotation + Math.sign(e.deltaY || e.deltaX) * 5 + 540) % 360) - 180;
      else st.width = Math.max(20, Math.min(8000, st.width * (e.deltaY > 0 ? 1 / 1.08 : 1.08)));
      app.emit('stencil');
    },
    { capture: true, passive: false },
  );
  window.addEventListener('keyup', (e) => {
    if (e.key.toLowerCase() === 's') {
      stencilKey = false;
      stencilDrag = null;
      wrap.classList.remove('stencil-edit');
      app.emit('brush');
    }
  });

  function updateCursor(e?: PointerEvent) {
    const show = hover && !altDown && !!app.mesh && !resize && app.tool !== 'select';
    cursor.style.display = show ? 'block' : 'none';
    if (!e) return;
    const r = wrap.getBoundingClientRect();
    const d = app.brush.size * 2;
    Object.assign(cursor.style, { width: `${d}px`, height: `${d}px`, left: `${e.clientX - r.left - d / 2}px`, top: `${e.clientY - r.top - d / 2}px` });
    cursor.className = `brush-cursor ${app.tool} ${app.part === 'mask' ? 'mask' : ''}`;
  }

  // ------------------------------------------------------------------ quick resize (Ctrl + right-drag)
  // Left/right = size, up/down = hardness, locked to whichever direction the drag starts in.
  const hud = h('div', { class: 'resize-hud' }, h('div', { class: 'resize-ring' }), h('div', { class: 'resize-core' }), h('div', { class: 'resize-label' }));
  wrap.append(hud);
  const [ring, core, label] = Array.from(hud.children) as HTMLElement[];
  let resize: { id: number; x: number; y: number; size: number; hardness: number; axis: 'size' | 'hardness' | null } | null = null;
  const showHud = () => {
    const b = app.brush;
    const d = b.size * 2;
    Object.assign(ring.style, { width: `${d}px`, height: `${d}px` });
    Object.assign(core.style, { width: `${d * b.hardness}px`, height: `${d * b.hardness}px` });
    label.textContent = resize?.axis === 'hardness' ? `Hardness ${b.hardness.toFixed(2)}` : `Size ${b.size}`;
  };
  wrap.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 2 || !e.ctrlKey || painting || resize || e.target !== canvas) return;
      e.stopPropagation(); // no panning
      e.preventDefault();
      const r = wrap.getBoundingClientRect();
      resize = { id: e.pointerId, x: e.clientX, y: e.clientY, size: app.brush.size, hardness: app.brush.hardness, axis: null };
      Object.assign(hud.style, { display: 'block', left: `${e.clientX - r.left}px`, top: `${e.clientY - r.top}px` });
      cursor.style.display = 'none';
      canvas.setPointerCapture(e.pointerId);
      showHud();
    },
    true,
  );
  canvas.addEventListener('pointermove', (e) => {
    if (!resize || e.pointerId !== resize.id) return;
    const dx = e.clientX - resize.x;
    const dy = e.clientY - resize.y;
    if (!resize.axis && Math.hypot(dx, dy) > 6) resize.axis = Math.abs(dx) >= Math.abs(dy) ? 'size' : 'hardness';
    const b = app.brush;
    // Size changes multiplicatively (fine control when small, fast when large); dragging up hardens.
    if (resize.axis === 'size') b.size = Math.round(Math.min(400, Math.max(1, resize.size * Math.pow(2, dx / 150))));
    if (resize.axis === 'hardness') b.hardness = +Math.min(1, Math.max(0, resize.hardness - dy / 250)).toFixed(2);
    showHud();
  });
  const endResize = (e: PointerEvent) => {
    if (!resize || e.pointerId !== resize.id) return;
    resize = null;
    hud.style.display = 'none';
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    app.emit('tool');
    app.emit('brush');
    updateCursor(e);
  };
  canvas.addEventListener('pointerup', endResize);
  canvas.addEventListener('pointercancel', endResize);

  // ------------------------------------------------------------------ polygon fill: face selection
  // Click / drag over faces adds them (Ctrl removes); Shift+drag selects the visible faces in a box.
  const boxEl = h('div', { class: 'face-box' });
  wrap.append(boxEl);
  let picking: { id: number; op: 'add' | 'remove'; box: boolean; cx: number; cy: number; x: number; y: number; last: number } | null = null;
  let hoverTri = -1;
  const setHover = (t: number) => {
    if (t === hoverTri) return;
    hoverTri = t;
    app.hoverFaces(t < 0 ? null : app.expandFaces([t]));
  };
  wrap.addEventListener(
    'pointerdown',
    (e) => {
      if (app.tool !== 'select' || e.button !== 0 || e.altKey || stencilKey || picking || e.target !== canvas || !app.mesh) return;
      e.stopPropagation();
      e.preventDefault();
      const b = toBuffer(e);
      const op = e.ctrlKey || e.metaKey ? 'remove' : 'add';
      picking = { id: e.pointerId, op, box: e.shiftKey, cx: e.clientX, cy: e.clientY, x: b.x, y: b.y, last: -1 };
      canvas.setPointerCapture(e.pointerId);
      if (!picking.box) {
        picking.last = app.pickFace(b.x, b.y);
        if (picking.last >= 0) app.selectFaces(app.expandFaces([picking.last]), op);
      }
    },
    true,
  );
  canvas.addEventListener('pointermove', (e) => {
    if (app.tool !== 'select') return;
    if (!picking) {
      if (!e.buttons) {
        const b = toBuffer(e);
        setHover(app.pickFace(b.x, b.y));
      }
      return;
    }
    if (e.pointerId !== picking.id) return;
    if (picking.box) {
      const r = wrap.getBoundingClientRect();
      Object.assign(boxEl.style, {
        display: 'block',
        left: `${Math.min(e.clientX, picking.cx) - r.left}px`,
        top: `${Math.min(e.clientY, picking.cy) - r.top}px`,
        width: `${Math.abs(e.clientX - picking.cx)}px`,
        height: `${Math.abs(e.clientY - picking.cy)}px`,
      });
      boxEl.classList.toggle('remove', picking.op === 'remove');
      return;
    }
    const b = toBuffer(e);
    const t = app.pickFace(b.x, b.y);
    if (t >= 0 && t !== picking.last) app.selectFaces(app.expandFaces([t]), picking.op);
    picking.last = t;
    setHover(t);
  });
  const endPick = (e: PointerEvent) => {
    if (!picking || e.pointerId !== picking.id) return;
    const p = picking;
    picking = null;
    boxEl.style.display = 'none';
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (!p.box || e.type === 'pointercancel') return;
    const b = toBuffer(e);
    // A Shift+click without dragging picks the single face under the cursor.
    if (Math.hypot(e.clientX - p.cx, e.clientY - p.cy) < 3) {
      const t = app.pickFace(b.x, b.y);
      if (t >= 0) app.selectFaces(app.expandFaces([t]), p.op);
    } else app.selectFaces(app.facesInRect(p.x, p.y, b.x, b.y), p.op);
    hoverTri = -1;
  };
  canvas.addEventListener('pointerup', endPick);
  canvas.addEventListener('pointercancel', endPick);
  canvas.addEventListener('pointerleave', () => setHover(-1));
  app.on((k) => {
    // The overlay is rebuilt for the new tool / view / set; the hover comes back on the next move.
    if (k === 'tool' || k === 'view' || k === 'set' || k === 'mesh' || k === 'faces') hoverTri = -1;
    if (k === 'tool') wrap.classList.toggle('face-select', app.tool === 'select');
  });

  // Capture phase so a painting click never reaches OrbitControls.
  wrap.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0 || e.altKey || painting || stencilKey || app.tool === 'select') return;
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
      smooth = null;
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
      else if (key === 's' && e.altKey) saveVersionDialog(app);
      else if (key === 's') saveProjectAction(app);
      else if (key === 'e') exportDialog(app);
      else if (key === 'o') void openMeshDialog(app);
      else if (key === 'g') app.addGroup(true);
      else if (key === 'a' && app.tool === 'select') app.selectAllFaces(!e.shiftKey);
      else if (key === 'i' && app.tool === 'select') app.invertFaces();
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
          case 'p':
            app.setTool('select');
            break;
          case 'escape':
            if (app.tool !== 'select') return;
            app.selectAllFaces(false);
            break;
          case '1':
          case '2':
          case '3':
          case '4':
            if (app.tool !== 'select') return;
            app.setFaceMode(FACE_MODES[+key - 1][0]);
            break;
          case 's':
            if (!e.repeat && stencilReady()) {
              stencilKey = true;
              wrap.classList.add('stencil-edit');
            }
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
          case 'u':
            app.setUVView(!app.uvView);
            break;
          case 'f':
            if (app.uvView) app.viewport.frameUV();
            else app.viewport.frame();
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
    // The S keyup is lost while another window has focus; a stuck stencil key would block painting.
    if (stencilKey) {
      stencilKey = false;
      stencilDrag = null;
      wrap.classList.remove('stencil-edit');
      app.emit('brush');
    }
  });
}
