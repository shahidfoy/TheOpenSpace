import { defineConfig } from 'vite';
import { createRequire } from 'node:module';

// Dev only: serve the DigitalOcean Function locally at the same path it has in production.
function functionsDev() {
  return {
    name: 'do-functions-dev',
    configureServer(server) {
      const require = createRequire(import.meta.url);
      server.middlewares.use('/api/threats/feed', async (req, res) => {
        try {
          const path = require.resolve('./functions/packages/threats/feed/index.js');
          delete require.cache[path]; // pick up edits without restarting
          const fn = require(path);
          const out = await fn.main({});
          res.writeHead(200, out.headers);
          res.end(JSON.stringify(out.body));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
    },
  };
}

// base './' so the build can be hosted from any static path (Telegram Mini Apps just need an HTTPS URL).
export default defineConfig({
  base: './',
  plugins: [functionsDev()],
  server: { host: true, port: 5173 },
  build: { target: 'es2020', chunkSizeWarningLimit: 1200 },
});
