/**
 * Keeps the last few errors of this session in memory (nothing is stored or sent), so a bug report can include them.
 * Users can't open DevTools in the desktop app, so this is the only way error details reach a report.
 */
interface ErrorEntry {
  time: number;
  text: string;
}

const MAX_ENTRIES = 15;
const entries: ErrorEntry[] = [];
let listener: ((text: string) => void) | null = null;

function describe(x: unknown): string {
  if (x instanceof Error) return x.stack || `${x.name}: ${x.message}`;
  if (typeof x === 'string') return x;
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

function record(text: string) {
  entries.push({ time: Date.now(), text: text.slice(0, 2000) });
  if (entries.length > MAX_ENTRIES) entries.shift();
  listener?.(text);
}

/** Starts recording uncaught errors, unhandled promise rejections and console.error output. */
export function installErrorCapture() {
  window.addEventListener('error', (e) => record(describe(e.error ?? e.message)));
  window.addEventListener('unhandledrejection', (e) => record(`Unhandled rejection: ${describe(e.reason)}`));
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    record(args.map(describe).join(' '));
    original(...args);
  };
}

/** Called for every recorded error (e.g. to offer a bug report). */
export function onErrorRecorded(fn: (text: string) => void) {
  listener = fn;
}

export function hasErrors() {
  return entries.length > 0;
}

/** The recorded errors, newest last, trimmed to `maxChars` (bug report URLs have a length limit). */
export function errorLog(maxChars = 3000): string {
  let out = '';
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const block = `[${new Date(e.time).toLocaleTimeString()}] ${e.text}\n`;
    if (out.length + block.length > maxChars) {
      if (!out) out = block.slice(0, maxChars);
      break;
    }
    out = block + out;
  }
  return out.trim();
}
