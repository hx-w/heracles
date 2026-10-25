import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  base: '/',
  esbuild: { jsx: 'automatic' },
  build: { outDir: 'dist', emptyOutDir: true },
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:8791' } },
  preview: { host: '127.0.0.1' },
});
