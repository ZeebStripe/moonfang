declare const __APP_VERSION__: string;

/** package.json version, e.g. "0.1.0-beta" */
export const VERSION = __APP_VERSION__;

/** Version as shown to users: "0.1.0-beta" → "Beta 0.1.0", "0.2.0-beta.3" → "Beta 0.2.0 (3)", "1.0.0" → "1.0.0". */
export function versionLabel(version: string): string {
  const [core, pre] = version.replace(/^v/, '').split('-');
  if (!pre) return core;
  const [name, ...rest] = pre.split('.');
  return `${name[0].toUpperCase()}${name.slice(1)} ${core}${rest.length ? ` (${rest.join('.')})` : ''}`;
}
export const VERSION_LABEL = versionLabel(VERSION);

export const REPO_URL = 'https://github.com/ZeebStripe/moonfang';
export const KOFI_URL = 'https://ko-fi.com/zeebstripe';
/**
 * The bug-report relay (report-relay/, a Cloudflare Worker), e.g. 'https://moonfang-reports.<you>.workers.dev/report'.
 * Empty until it is deployed: Report a Bug then opens the prefilled GitHub issue form instead.
 */
export const REPORT_ENDPOINT = 'https://moonfang-reports.gay-hyena.workers.dev/report';

/** Browser, OS and GPU, for bug reports. */
export function environmentInfo(gl: WebGL2RenderingContext | WebGLRenderingContext): string {
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  return [`User agent: ${navigator.userAgent}`, `GPU: ${gpu}`, `Screen: ${screen.width}×${screen.height} @${devicePixelRatio}x`].join('\n');
}

/**
 * The GitHub bug-report form with the version, environment and this session's errors already filled in. Nothing is
 * sent until the user reviews the form in their browser and submits it.
 */
export function bugReportUrl(gl: WebGL2RenderingContext | WebGLRenderingContext, errors = ''): string {
  const q = new URLSearchParams({ template: 'bug_report.yml', version: VERSION_LABEL, environment: environmentInfo(gl) });
  if (errors) q.set('logs', errors);
  return `${REPO_URL}/issues/new?${q}`;
}
