import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  publicDir: '../assets',
  server: { host: true },
  build: { outDir: 'dist', assetsInlineLimit: 0 },
});
