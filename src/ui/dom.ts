type Child = Node | string | number | null | undefined | false;

/** Tiny hyperscript helper: h('div', { class: 'x', onclick: fn }, ...children) */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k in el && !['list', 'type', 'form'].includes(k)) (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export function icon(svg: string, cls = 'icon'): HTMLSpanElement {
  return h('span', { class: cls, html: svg });
}

export interface SliderOpts {
  value: number;
  min: number;
  max: number;
  step?: number;
  onInput: (v: number) => void;
  onCommit?: (v: number) => void;
  digits?: number;
  title?: string;
}

export function slider(label: string, o: SliderOpts): HTMLElement {
  const step = o.step ?? 0.01;
  const digits = o.digits ?? (step >= 1 ? 0 : 2);
  const range = h('input', { type: 'range', min: o.min, max: o.max, step, value: o.value }) as HTMLInputElement;
  const num = h('input', { type: 'number', class: 'num', min: o.min, max: o.max, step, value: o.value.toFixed(digits) }) as HTMLInputElement;
  const fill = () => range.style.setProperty('--fill', `${((Number(range.value) - o.min) / (o.max - o.min)) * 100}%`);
  fill();
  range.addEventListener('input', () => {
    num.value = Number(range.value).toFixed(digits);
    fill();
    o.onInput(Number(range.value));
  });
  range.addEventListener('change', () => o.onCommit?.(Number(range.value)));
  num.addEventListener('change', () => {
    const v = Math.min(o.max, Math.max(o.min, Number(num.value) || 0));
    num.value = v.toFixed(digits);
    range.value = String(v);
    fill();
    o.onInput(v);
    o.onCommit?.(v);
  });
  return h('div', { class: 'field slider', title: o.title }, h('label', {}, label), range, num);
}

export function checkbox(label: string, value: boolean, onChange: (v: boolean) => void, title?: string): HTMLElement {
  const input = h('input', { type: 'checkbox', checked: value, onchange: () => onChange(input.checked) }) as HTMLInputElement;
  return h('label', { class: 'field check', title }, input, h('span', {}, label));
}

export function selectField<T extends string | number>(
  label: string,
  options: readonly (readonly [T, string])[],
  value: T,
  onChange: (v: T) => void,
): HTMLElement {
  const sel = h('select', {}) as HTMLSelectElement;
  for (const [v, l] of options) sel.append(h('option', { value: String(v), selected: v === value }, l));
  sel.addEventListener('change', () => {
    const found = options.find(([v]) => String(v) === sel.value);
    if (found) onChange(found[0]);
  });
  return h('div', { class: 'field select' }, label ? h('label', {}, label) : null, sel);
}

export function srgbToHex(c: readonly number[]): string {
  return '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
}
export function hexToSrgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Reads a typed colour: hex ("#FF8800", "ff8800", "#F80"), or three numbers ("255, 136, 0", "rgb(255 136 0)").
 * Numbers are 0–255, unless all are at most 1 and one has a decimal point ("1, 0.53, 0"): then they are 0–1.
 */
export function parseColor(text: string): [number, number, number] | null {
  const s = text.trim().toLowerCase();
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hex) {
    const d = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return hexToSrgb('#' + d);
  }
  const nums = s.replace(/^rgb\s*\(|\)$/g, '').split(/[\s,;/]+/).filter(Boolean);
  if (nums.length !== 3 || !nums.every((n) => /^\d*\.?\d+$/.test(n))) return null;
  const v = nums.map(Number);
  const unit = v.every((x) => x <= 1) && nums.some((n) => n.includes('.'));
  if (!unit && v.some((x) => x > 255)) return null;
  return v.map((x) => (unit ? x : x / 255)) as [number, number, number];
}

export function colorField(label: string, value: [number, number, number], onInput: (c: [number, number, number]) => void): HTMLElement {
  const input = h('input', { type: 'color', value: srgbToHex(value) }) as HTMLInputElement;
  const text = h('input', {
    type: 'text',
    class: 'hex',
    value: srgbToHex(value).toUpperCase(),
    spellcheck: false,
    title: 'Type a colour: hex (#FF8800) or RGB (255, 136, 0). Enter applies, Esc cancels.',
  }) as HTMLInputElement;
  const shown = () => input.value.toUpperCase();
  input.addEventListener('input', () => {
    text.value = shown();
    text.classList.remove('invalid');
    onInput(hexToSrgb(input.value));
  });
  const apply = () => {
    const c = parseColor(text.value);
    if (!c) return void text.classList.add('invalid');
    text.classList.remove('invalid');
    input.value = srgbToHex(c);
    text.value = shown();
    onInput(c);
  };
  const revert = () => {
    text.value = shown();
    text.classList.remove('invalid');
  };
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      apply();
      text.select();
    } else if (e.key === 'Escape') {
      revert();
      text.blur();
    }
  });
  text.addEventListener('input', () => text.classList.toggle('invalid', !parseColor(text.value)));
  // Leaving the box applies a changed, valid colour and drops an unfinished one.
  text.addEventListener('blur', () => {
    if (text.value.trim().toUpperCase() === shown()) return;
    if (parseColor(text.value)) apply();
    else revert();
  });
  text.addEventListener('focus', () => text.select());
  return h('div', { class: 'field color' }, h('label', {}, label), input, text);
}

export function section(title: string, ...children: (Child | Child[])[]): HTMLElement {
  return h('div', { class: 'section' }, h('div', { class: 'section-title' }, title), ...children);
}

export function iconButton(svg: string, title: string, onClick: (e: MouseEvent) => void, cls = ''): HTMLButtonElement {
  return h('button', { class: `icon-btn ${cls}`, title, 'aria-label': title, onclick: onClick }, icon(svg)) as HTMLButtonElement;
}

/** Opens a file picker and resolves with the chosen file (or null). */
export async function pickFile(accept: string): Promise<File | null> {
  return (await pickFiles(accept, false))[0] ?? null;
}

/** Opens a folder picker and resolves with every file inside (paths in webkitRelativePath; empty when cancelled). */
/**
 * Opens a link in the user's own browser. The desktop app does that for window.open; the launcher's app window has
 * no tabs, so there the local server opens it (see vite.config.ts), with a plain new tab as the fallback.
 */
export function openExternal(url: string) {
  const tab = () => void window.open(url, '_blank', 'noopener');
  if ('moonfangDesktop' in window) return tab();
  fetch('/__moonfang/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) })
    .then((r) => !r.ok && tab())
    .catch(tab);
}

/** A link that opens in the user's browser (see openExternal). */
export function externalLink(url: string, label: string): HTMLAnchorElement {
  return h('a', { href: url, rel: 'noopener', onclick: (e: MouseEvent) => (e.preventDefault(), openExternal(url)) }, label);
}

export function pickFolder(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', style: { display: 'none' } }) as HTMLInputElement;
    input.webkitdirectory = true;
    input.addEventListener('change', () => {
      resolve(Array.from(input.files ?? []));
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

/** Opens a file picker and resolves with the chosen files (empty when cancelled). */
export function pickFiles(accept: string, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, style: { display: 'none' } }) as HTMLInputElement;
    input.addEventListener('change', () => {
      resolve(Array.from(input.files ?? []));
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}
