/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves at https://<user>.github.io/<repo>/, so assets need
// the repo prefix. Override via VITE_BASE if you ever rename the repo.
const base = process.env.VITE_BASE ?? '/hollowsurv/';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base,
  server: {
    port: 5173,
    open: false,
  },
  // Vitest configuration. Tests live in `src/**/__tests__/*.test.ts`. We use
  // jsdom for tests that touch DOM-ish things (localStorage for the metaStore
  // migration test); plain node otherwise.
  test: {
    environment: 'jsdom',
    include: ['src/**/__tests__/*.test.ts'],
    globals: false,
  },
  build: {
    target: 'es2022',
    // Bundle-size optimisation: ship no public sourcemaps in production. Use
    // 'hidden' to keep .map files emitted alongside JS without referencing them
    // in the bundle (so crash reporters that read them out-of-band still work
    // but the browser doesn't fetch them).
    sourcemap: 'hidden',
    rollupOptions: {
      output: {
        // Manual chunk splitting (function form — required by Vite 8 / Rolldown).
        //  - phaser  → ~1.2 MB on its own; lazy-loaded after the menu paints
        //  - react   → react + react-dom (~140 KB), needed for first paint
        //  - zustand → tiny but vendored separately to keep app chunk stable
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('phaser')) return 'phaser';
            if (id.includes('react-dom') || id.match(/[\\/]react[\\/]/)) return 'react';
            if (id.includes('zustand')) return 'zustand';
          }
          return undefined;
        },
      },
    },
  },
});
