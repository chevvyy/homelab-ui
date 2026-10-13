import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import { join, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import { identify, proxyProtocolListener } from './auth.js';
import { config } from './config.js';
import { backupTo } from './db.js';
import { cache } from './k8s/cache.js';
import { metrics } from './k8s/nodes.js';
import { registerRoutes } from './routes.js';
import { proxmox } from './systems/proxmox.js';
import { truenas } from './systems/truenas.js';
import { registerRealtime } from './ws.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 2 * 1024 * 1024 });

// Every request (including WebSocket upgrades) must come from a signed-in Tailscale user.
app.decorateRequest('user', null);
app.addHook('onRequest', async (req, reply) => {
  const { identity, reason } = await identify(req.raw.socket);
  if (!identity) {
    if (req.url.startsWith('/api/')) return reply.code(401).send({ error: { title: 'Not signed in', cause: reason } });
    return reply.code(401).type('text/html').send(`<!doctype html><meta name=viewport content="width=device-width"><title>Not signed in</title><body style="font-family:system-ui;padding:2rem;max-width:40rem"><h1>Homelab controller</h1><p>${(reason ?? '').replace(/</g, '&lt;')}</p><p>Open this page from a device signed in to your tailnet.</p></body>`);
  }
  (req as any).user = identity;
});

await app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } });
registerRealtime(app);
registerRoutes(app);

const webDir = resolve(config.webDir);
if (existsSync(webDir)) {
  await app.register(fastifyStatic, { root: webDir, wildcard: false });
  // SPA: unknown non-API paths serve index.html.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: { title: 'Not found' } });
    return reply.sendFile('index.html');
  });
} else {
  app.log.warn(`web build not found at ${webDir}; serving API only`);
}

await app.ready();
cache.start();
metrics.start();
void proxmox.start();
void truenas.start();

// UI listener: loopback only in production (the Tailscale sidecar is the only client).
proxyProtocolListener(app.server).listen(config.uiPort, config.uiHost, () => {
  app.log.info(`UI listening on ${config.uiHost}:${config.uiPort} (auth: ${config.authMode})`);
});

// Probe listener: no auth, no data.
http
  .createServer((req, res) => {
    if (req.url === '/readyz') {
      res.writeHead(cache.synced() ? 200 : 503).end(cache.synced() ? 'ready' : 'syncing');
      return;
    }
    res.writeHead(req.url === '/healthz' ? 200 : 404).end(req.url === '/healthz' ? 'ok' : '');
  })
  .listen(config.healthPort, '0.0.0.0');

// Nightly SQLite backup to the NAS-backed volume, keeping two weeks.
const backupDir = process.env.BACKUP_DIR;
if (backupDir) {
  const schedule = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(3, 15, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    setTimeout(async () => {
      try {
        const file = join(backupDir, `homelab-ui-${new Date().toISOString().slice(0, 10)}.db`);
        await rm(file, { force: true });
        backupTo(file);
        const old = (await readdir(backupDir)).filter((f) => /^homelab-ui-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().slice(0, -14);
        for (const f of old) await rm(join(backupDir, f), { force: true });
        app.log.info(`backup written: ${file}`);
      } catch (e) {
        app.log.error({ err: e }, 'backup failed');
      }
      schedule();
    }, next.getTime() - now.getTime());
  };
  schedule();
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    app.log.info(`${sig} received, shutting down`);
    void app.close().finally(() => process.exit(0));
  });
}
