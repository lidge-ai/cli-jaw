import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      lib: { entry: resolve(__dirname, 'src/main/index.ts') },
      rollupOptions: { external: ['electron', 'electron-updater', 'fix-path', 'node-pty'] },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      lib: {
        entry: resolve(__dirname, 'src/preload/index.ts'),
        formats: ['cjs'],
      },
      rollupOptions: {
        external: ['electron'],
        output: { entryFileNames: 'index.js' },
      },
    },
  },
});
