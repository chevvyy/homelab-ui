// Informer-style watch cache: list once, then watch from that resourceVersion. A 410 Gone
// (expired resourceVersion) or a dropped stream triggers a relist so the cache never goes
// silently stale.
import { EventEmitter } from 'node:events';
import { K8sError, KObject, R, ResourceKey, request, resourcePath, streamLines } from './client.js';

export type WatchState = { synced: boolean; error?: string; lastSync?: number; lastEvent?: number };

const WATCHED: ResourceKey[] = [
  'namespaces',
  'nodes',
  'pods',
  'services',
  'deployments',
  'replicasets',
  'statefulsets',
  'daemonsets',
  'jobs',
  'cronjobs',
  'pvcs',
  'events',
  'ingresses',
  'ingressroutes',
];

const EVENT_TTL_MS = 60 * 60 * 1000;
// The API server ends each watch after WATCH_SECONDS. If a stream is still open well past that,
// the connection is dead without having closed; abort it.
const WATCH_SECONDS = Number(process.env.WATCH_SECONDS ?? 300);
const WATCHDOG_MS = (WATCH_SECONDS + 60) * 1000;
// Safety net: re-list everything periodically so any missed event heals within this window.
const RELIST_MS = Number(process.env.RELIST_SECONDS ?? 600) * 1000;

function slim(obj: KObject): KObject {
  const md = { ...obj.metadata };
  delete md.managedFields;
  if (md.annotations) {
    const a = { ...md.annotations };
    delete a['kubectl.kubernetes.io/last-applied-configuration'];
    md.annotations = a;
  }
  return { ...obj, metadata: md };
}

function keyOf(obj: KObject): string {
  return obj.metadata.namespace ? `${obj.metadata.namespace}/${obj.metadata.name}` : obj.metadata.name;
}

class Watcher {
  items = new Map<string, KObject>();
  state: WatchState = { synced: false };
  private resourceVersion = '';
  private abort?: AbortController;
  private stopped = false;
  private backoff = 1000;
  private lastList = 0;

  constructor(
    public key: ResourceKey,
    private onChange: (key: ResourceKey) => void,
  ) {}

  start() {
    void this.loop();
  }

  stop() {
    this.stopped = true;
    this.abort?.abort();
  }

  private async list() {
    const rt = R[this.key];
    const res = await request<any>('GET', resourcePath(rt), { query: { limit: 0 } });
    const next = new Map<string, KObject>();
    for (const item of res.items ?? []) {
      const obj = slim({ ...item, apiVersion: res.apiVersion, kind: rt.kind });
      next.set(keyOf(obj), obj);
    }
    this.items = next;
    this.resourceVersion = res.metadata?.resourceVersion ?? '';
    this.lastList = Date.now();
    this.state = { synced: true, lastSync: this.lastList, lastEvent: this.lastList };
    this.onChange(this.key);
  }

  private async watch() {
    const rt = R[this.key];
    this.abort = new AbortController();
    const abort = this.abort;
    const watchdog = setTimeout(() => abort.abort(), WATCHDOG_MS);
    let gone = false;
    await streamLines(
      resourcePath(rt),
      { watch: 1, resourceVersion: this.resourceVersion, allowWatchBookmarks: true, timeoutSeconds: WATCH_SECONDS },
      (line) => {
        this.state.lastEvent = Date.now();
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        const obj = ev.object as KObject;
        if (ev.type === 'ERROR') {
          if ((obj as any)?.code === 410) gone = true;
          return;
        }
        if (obj?.metadata?.resourceVersion) this.resourceVersion = obj.metadata.resourceVersion;
        if (ev.type === 'BOOKMARK') return;
        const full = slim({ ...obj, kind: rt.kind });
        if (ev.type === 'DELETED') this.items.delete(keyOf(full));
        else this.items.set(keyOf(full), full);
        this.onChange(this.key);
      },
      abort.signal,
    ).finally(() => clearTimeout(watchdog));
    if (gone || Date.now() - this.lastList > RELIST_MS) this.resourceVersion = '';
  }

  private async loop() {
    while (!this.stopped) {
      try {
        if (!this.resourceVersion) await this.list();
        await this.watch();
        this.backoff = 1000;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const forbidden = e instanceof K8sError && e.status === 403;
        if (e instanceof K8sError && e.status === 410) this.resourceVersion = '';
        this.state = { ...this.state, error: forbidden ? `No permission to watch ${this.key}` : msg };
        this.onChange(this.key);
        await new Promise((r) => setTimeout(r, forbidden ? 60_000 : this.backoff));
        this.backoff = Math.min(this.backoff * 2, 30_000);
        if (!forbidden) this.resourceVersion = '';
      }
    }
  }

  pruneEvents() {
    const cutoff = Date.now() - EVENT_TTL_MS;
    let changed = false;
    for (const [k, ev] of this.items) {
      const t = Date.parse(ev.lastTimestamp ?? ev.eventTime ?? ev.metadata.creationTimestamp ?? '');
      if (t && t < cutoff) {
        this.items.delete(k);
        changed = true;
      }
    }
    if (changed) this.onChange(this.key);
  }
}

class ClusterCache extends EventEmitter {
  private watchers = new Map<ResourceKey, Watcher>();
  private dirty = new Set<ResourceKey>();
  private flushTimer?: NodeJS.Timeout;

  start() {
    for (const key of WATCHED) {
      const w = new Watcher(key, (k) => this.markDirty(k));
      this.watchers.set(key, w);
      w.start();
    }
    setInterval(() => this.watchers.get('events')?.pruneEvents(), 60_000).unref();
  }

  private markDirty(key: ResourceKey) {
    this.dirty.add(key);
    // Coalesce bursts (a rollout touches pods, RS and deployment at once) into one update.
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = undefined;
      const kinds = [...this.dirty];
      this.dirty.clear();
      this.emit('change', kinds);
    }, 250);
  }

  list(key: ResourceKey, namespace?: string): KObject[] {
    const items = [...(this.watchers.get(key)?.items.values() ?? [])];
    return namespace ? items.filter((o) => o.metadata.namespace === namespace) : items;
  }

  get(key: ResourceKey, namespace: string | undefined, name: string): KObject | undefined {
    return this.watchers.get(key)?.items.get(namespace ? `${namespace}/${name}` : name);
  }

  states(): Record<string, WatchState> {
    return Object.fromEntries([...this.watchers].map(([k, w]) => [k, w.state]));
  }

  synced(): boolean {
    return [...this.watchers.values()].every((w) => w.state.synced || w.state.error);
  }
}

export const cache = new ClusterCache();
