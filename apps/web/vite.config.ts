import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The dev server proxies the API so the UI and SSE work same-origin, as in production.
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs resolve against <base href>, so one build serves any BASE_PATH.
  base: './',
  server: {
    host: true,
    proxy: { '/api': { target: apiTarget, changeOrigin: false } },
  },
});
