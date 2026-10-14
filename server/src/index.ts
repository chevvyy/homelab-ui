import { existsSync, readFileSync, statSync } from 'node:fs';
import tls from 'node:tls';
import { readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import { join, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import { identify, proxyProtocolListener } from './auth.js';
import { config } from './config.js';
import { backupTo, failInterruptedBuilds } from './db.js';
import { cache } from './k8s/cache.js';
import { startLanCertSync } from './k8s/lantls.js';
import { metrics } from './k8s/nodes.js';
import { registerRoutes } from './routes.js';
import { proxmox } from './systems/proxmox.js';
import { truenas } from './systems/truenas.js';
import { registerRealtime } from './ws.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 2 * 1024 * 1024 });

let tlsEnabled = false;
const tlsConfigured = !!(config.tlsCert && config.tlsKey);

// cert-manager renews the certificate in place; reload it when the file changes.
let tlsContext: tls.SecureContext | undefined;
let tlsMtime = 0;
function secureContext(): tls.SecureContext {
  const m = statSync(config.tlsCert).mtimeMs;
  if (!tlsContext || m !== tlsMtime) {
    tlsContext = tls.createSecureContext({ cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey) });
    tlsMtime = m;
  }
  return tlsContext;
}

// Every request (including WebSocket upgrades) must come from a signed-in Tailscale user.
app.decorateRequest('user', null);
app.addHook('onRequest', async (req, reply) => {
  // With TLS on, the plain listener only redirects.
  if (tlsEnabled && !(req.raw.socket as tls.TLSSocket).encrypted) {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    return reply.redirect(`https://${host}${req.url}`, 308);
  }
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
const interrupted = failInterruptedBuilds();
if (interrupted) app.log.warn(`${interrupted} unfinished GitHub deploy(s) marked failed after restart`);
cache.start();
metrics.start();
startLanCertSync();
void proxmox.start();
void truenas.start();

// UI listeners: loopback only in production (the Tailscale sidecar is the only client).
proxyProtocolListener(app.server).listen(config.uiPort, config.uiHost, () => {
  app.log.info(`UI listening on ${config.uiHost}:${config.uiPort} (auth: ${config.authMode})`);
});
// The certificate Secret may be issued after the pod starts; begin serving HTTPS (and
// redirecting HTTP) as soon as it appears.
const startTls = () => {
  if (tlsEnabled || !tlsConfigured || !existsSync(config.tlsCert) || !existsSync(config.tlsKey)) return;
  tlsEnabled = true;
  proxyProtocolListener(app.server, secureContext).listen(config.tlsPort, config.uiHost, () => {
    app.log.info(`HTTPS listening on ${config.uiHost}:${config.tlsPort}; plain HTTP now redirects`);
  });
};
startTls();
if (tlsConfigured && !tlsEnabled) {
  const t = setInterval(() => (startTls(), tlsEnabled && clearInterval(t)), 30_000);
}

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
