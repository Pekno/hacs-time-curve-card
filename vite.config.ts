import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  root: 'dev',
  publicDir: false,
  define: {
    __CARD_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    minify: 'esbuild',
    sourcemap: false,
    lib: {
      entry: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'time-curve-card.js',
    },
    rollupOptions: {
      // Lit must be bundled in: HA does not provide it to custom cards.
      external: [],
      output: { inlineDynamicImports: true },
    },
  },
  server: { port: 5173, open: false },
});
