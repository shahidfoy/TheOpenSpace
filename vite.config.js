import { defineConfig, loadEnv } from 'vite';
import { createRequire } from 'node:module';

// Dev only: serve the DigitalOcean Functions locally at the same paths they have in production.
// Optional threat-feed keys (ABUSECH_KEY, OTX_KEY, ...) can go in an untracked .env.local.
const FEED_KEYS = ['ABUSECH_KEY', 'OTX_KEY', 'CLOUDFLARE_RADAR_TOKEN', 'ABUSEIPDB_KEY', 'NVD_API_KEY'];
function functionsDev() {
  return {
    name: 'do-functions-dev',
    configureServer(server) {
      const e = loadEnv(server.config.mode, process.cwd(), '');
      for (const k of FEED_KEYS) if (e[k] && !process.env[k]) process.env[k] = e[k];
      const require = createRequire(import.meta.url);
      for (const fnPath of ['threats/feed', 'weather/storms']) {
        server.middlewares.use(`/api/${fnPath}`, async (req, res) => {
          try {
            const path = require.resolve(`./functions/packages/${fnPath}/index.js`);
            delete require.cache[path]; // pick up edits without restarting
            const fn = require(path);
            const out = await fn.main(Object.fromEntries(new URL(req.url, 'http://dev').searchParams));
            res.writeHead(200, out.headers);
            res.end(JSON.stringify(out.body));
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(e) }));
          }
        });
      }
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
