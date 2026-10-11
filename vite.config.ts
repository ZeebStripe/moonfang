import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

export default defineConfig({
  base: './',
  server: { port: 5178 },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    {
      // The licenses of the bundled libraries travel with every build.
      name: 'third-party-notices',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.md', source: readFileSync('THIRD_PARTY_NOTICES.md', 'utf8') });
      },
    },
  ],
});
