// One WebSocket per browser tab. On connect it receives a full snapshot; afterwards every
// topic (apps, cluster, proxmox, truenas, builds) is re-sent whenever it changes.
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { followLogs } from './k8s/actions.js';
import { buildApps } from './k8s/apps.js';
import { cache } from './k8s/cache.js';
import { buildNodes, metrics } from './k8s/nodes.js';
import { builds } from './github.js';
import { proxmox } from './systems/proxmox.js';
import { truenas } from './systems/truenas.js';

const clients = new Set<WebSocket>();

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg: unknown) {
  const data = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
}

function clusterMsg() {
  return {
    t: 'cluster',
    nodes: buildNodes(),
    namespaces: cache.list('namespaces').map((n) => n.metadata.name).sort(),
    watch: cache.states(),
    metrics: metrics.available,
    synced: cache.synced(),
  };
}

const APP_KINDS = new Set(['pods', 'services', 'deployments', 'replicasets', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs', 'events', 'ingresses', 'ingressroutes', 'pvcs']);

export function registerRealtime(app: FastifyInstance) {
  cache.on('change', (kinds: string[]) => {
    if (!clients.size) return;
    if (kinds.some((k) => APP_KINDS.has(k))) broadcast({ t: 'apps', apps: buildApps() });
    if (kinds.some((k) => k === 'nodes' || k === 'namespaces' || k === 'pods')) broadcast(clusterMsg());
  });
  metrics.on('update', () => clients.size && broadcast(clusterMsg()));
  proxmox.on('update', () => broadcast({ t: 'proxmox', state: proxmox.state }));
  truenas.on('update', () => broadcast({ t: 'truenas', state: truenas.state }));
  builds.on('update', (b) => broadcast({ t: 'build', build: b }));

  app.get('/api/ws', { websocket: true }, (socket, req) => {
    clients.add(socket);
    send(socket, { t: 'hello', user: (req as any).user });
    send(socket, { t: 'apps', apps: buildApps() });
    send(socket, clusterMsg());
    send(socket, { t: 'proxmox', state: proxmox.state });
    send(socket, { t: 'truenas', state: truenas.state });
    socket.on('message', (raw) => {
      if (raw.toString() === 'ping') socket.send('pong');
    });
    socket.on('close', () => clients.delete(socket));
  });

  // Live log tail for one container.
  app.get('/api/ws/logs', { websocket: true }, (socket, req) => {
    const q = req.query as { namespace?: string; pod?: string; container?: string };
    if (!q.namespace || !q.pod) {
      socket.close(1008, 'namespace and pod required');
      return;
    }
    const abort = new AbortController();
    socket.on('close', () => abort.abort());
    followLogs(q.namespace, q.pod, q.container || undefined, (line) => send(socket, { line }), abort.signal)
      .then(() => send(socket, { end: true }))
      .catch((e) => send(socket, { error: e instanceof Error ? e.message : String(e) }))
      .finally(() => socket.readyState === socket.OPEN && socket.close());
  });
}

