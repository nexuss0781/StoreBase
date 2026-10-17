import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: projectRoot,
  publicDir: false,
  optimizeDeps: {
    exclude: ['@mtcute/wasm'],
  },
  build: {
    outDir: path.join(projectRoot, 'www'),
    emptyOutDir: false,
    target: 'es2022',
    assetsInlineLimit: 0,
    lib: {
      entry: path.join(projectRoot, 'src/telegram-direct.js'),
      formats: ['es'],
      fileName: () => 'telegram-direct.js',
    },
    rollupOptions: {
      output: {
        entryFileNames: 'telegram-direct.js',
        assetFileNames: 'mtcute-[name]-[hash][extname]',
      },
    },
  },
});
