import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, type Connect } from 'vite';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

/** Sites the app links to. Nothing else can be opened through the endpoint below. */
const LINK_HOSTS = ['github.com', 'ko-fi.com'];

/**
 * POST /__moonfang/open {url}: opens a link in the system's default browser. The launcher shows Moonfang in a browser
 * window without tabs or address bar, where window.open would replace the app with the link. Only the app's own page
 * may call it (same origin), and only for https links to LINK_HOSTS.
 */
const openLink: Connect.NextHandleFunction = (req: IncomingMessage, res: ServerResponse, next) => {
  if (req.url !== '/__moonfang/open' || req.method !== 'POST') return next();
  const reply = (code: number) => res.writeHead(code).end();
  try {
    if (new URL(req.headers.origin ?? '').host !== req.headers.host) return reply(403);
  } catch {
    return reply(403);
  }
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()).length > 20000 && req.destroy());
  req.on('end', () => {
    let url: URL;
    try {
      url = new URL((JSON.parse(body) as { url: string }).url);
    } catch {
      return reply(400);
    }
    if (url.protocol !== 'https:' || !LINK_HOSTS.includes(url.hostname)) return reply(403);
    // No shell, so the URL is passed through as one argument.
    const [cmd, args] =
      process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url.href]] : process.platform === 'darwin' ? ['open', [url.href]] : ['xdg-open', [url.href]];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
    reply(204);
  });
};

export default defineConfig({
  base: './',
  server: { port: 5178 },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    {
      name: 'open-links-in-browser',
      configureServer: (server) => void server.middlewares.use(openLink),
      configurePreviewServer: (server) => void server.middlewares.use(openLink),
    },
    {
      // The licenses of the bundled libraries travel with every build.
      name: 'third-party-notices',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.md', source: readFileSync('THIRD_PARTY_NOTICES.md', 'utf8') });
      },
    },
  ],
});
