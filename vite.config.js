import { defineConfig } from 'vite';

// base './' so the build can be hosted from any static path (Telegram Mini Apps just need an HTTPS URL).
export default defineConfig({
  base: './',
  server: { host: true, port: 5173 },
  build: { target: 'es2020', chunkSizeWarningLimit: 1200 },
});
