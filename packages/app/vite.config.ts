import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              // Only externalize truly native modules and electron itself
              external: [
                'electron',
                'hnswlib-node',
              ],
            },
          },
        },
      },
    ]),
    renderer(),
  ],
  build: {
    outDir: 'dist',
  },
});
