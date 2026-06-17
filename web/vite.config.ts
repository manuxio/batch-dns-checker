import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During local development, proxy API calls to the backend on port 3001.
// In production the SPA is served by nginx, which proxies /api to the server.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
