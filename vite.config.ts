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
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
