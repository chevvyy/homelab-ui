// TrueNAS SCALE: JSON-RPC 2.0 over WebSocket with an API key (REST is removed in 26). The API
// version is pinned in the URL so method shapes don't shift under us. View-only by design:
// system info, pools, datasets and live alerts.
import { EventEmitter } from 'node:events';
import { Agent, fetch } from 'undici';
import WebSocket from 'ws';
import { readSecret } from '../secrets.js';

export interface TnPool {
  id: number;
  name: string;
  status: string;
  healthy: boolean;
  size: number;
  allocated: number;
  free: number;
  scan?: { function?: string; state?: string; end_time?: number; errors?: number; percentage?: number };
  vdevErrors: number;
}

export interface TnDataset {
  id: string;
  pool: string;
  used: number;
  available: number;
  type: string;
  mountpoint?: string;
  encrypted: boolean;
  compression?: string;
}

export interface TnAlert {
  uuid: string;
  level: string;
  klass: string;
  formatted: string;
  datetime?: number;
  dismissed: boolean;
}

export interface TrueNasState {
  configured: boolean;
  connected: boolean;
  error?: string;
  lastUpdate?: number;
  apiVersion?: string;
  system?: { hostname: string; version: string; uptimeSeconds: number; loadavg: number[]; physmem: number; cores: number; model?: string };
  pools: TnPool[];
  datasets: TnDataset[];
  alerts: TnAlert[];
}

const insecure = new Agent({ connect: { rejectUnauthorized: false } });

function num(v: any): number {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object') return Number(v.parsed ?? v.rawvalue ?? 0);
  return Number(v) || 0;
}

async function pickApiVersion(httpBase: string): Promise<string> {
  try {
    const res = await fetch(`${httpBase}/api/versions`, { dispatcher: insecure, signal: AbortSignal.timeout(8000) });
    const versions: string[] = await res.json() as string[];
    if (Array.isArray(versions) && versions.length) return versions[versions.length - 1];
  } catch {
    /* fall through */
  }
  return 'current';
}

class TrueNas extends EventEmitter {
  state: TrueNasState = { configured: false, connected: false, pools: [], datasets: [], alerts: [] };
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private refreshTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private failures = 0;
  private generation = 0;

  async start() {
    await this.reload();
  }

  async reload() {
    this.generation++;
    this.teardown();
    const s = await readSecret('truenas').catch(() => undefined);
    if (!s?.url || !s.apiKey) {
      this.state = { configured: false, connected: false, pools: [], datasets: [], alerts: [], error: 'Not configured: add the TrueNAS URL and API key in Settings.' };
      this.emit('update');
      this.reconnectTimer = setTimeout(() => void this.reload(), 60_000);
      return;
    }
    void this.connect(s.url, s.apiKey, s.username, this.generation);
  }

  private teardown() {
    clearTimeout(this.refreshTimer);
    clearTimeout(this.reconnectTimer);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Connection closed'));
    }
    this.pending.clear();
    this.ws?.removeAllListeners();
    this.ws?.terminate();
    this.ws = undefined;
  }

  private call<T = any>(method: string, params: unknown[] = []): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Not connected'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`TrueNAS call ${method} timed out`));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  private async connect(rawUrl: string, apiKey: string, username: string | undefined, gen: number) {
    const u = new URL(rawUrl.includes('://') ? rawUrl : `wss://${rawUrl}`);
    const secure = u.protocol === 'wss:' || u.protocol === 'https:';
    const httpBase = `${secure ? 'https' : 'http'}://${u.host}`;
    const version = await pickApiVersion(httpBase);
    if (gen !== this.generation) return;
    const wsUrl = `${secure ? 'wss' : 'ws'}://${u.host}/api/${version}`;
    const ws = new WebSocket(wsUrl, { rejectUnauthorized: false, handshakeTimeout: 10_000 });
    this.ws = ws;

    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.data?.reason ?? msg.error.message ?? 'TrueNAS error'));
        else p.resolve(msg.result);
        return;
      }
      // Subscription push: any alert change -> refetch the list.
      if (msg.method === 'collection_update' && msg.params?.collection === 'alert.list') void this.refreshAlerts();
    });
    ws.on('open', async () => {
      try {
        let ok = false;
        if (username) {
          const r = await this.call<any>('auth.login_ex', [{ mechanism: 'API_KEY_PLAIN', username, api_key: apiKey }]).catch(() => undefined);
          ok = r?.response_type === 'SUCCESS';
        }
        if (!ok) ok = await this.call<boolean>('auth.login_with_api_key', [apiKey]);
        if (!ok) throw new Error('TrueNAS rejected the API key. Check it in Settings (keys are revoked if ever sent over plain HTTP).');
        await this.call('core.subscribe', ['alert.list']).catch(() => undefined);
        this.failures = 0;
        this.state = { ...this.state, configured: true, connected: true, error: undefined, apiVersion: version };
        await this.refresh();
      } catch (e) {
        this.fail(e, gen, rawUrl, apiKey, username);
      }
    });
    ws.on('error', (e) => this.fail(e, gen, rawUrl, apiKey, username));
    ws.on('close', () => this.fail(new Error('Connection closed'), gen, rawUrl, apiKey, username));
  }

  private fail(e: unknown, gen: number, url: string, apiKey: string, username?: string) {
    if (gen !== this.generation || this.reconnectTimer) return;
    this.failures++;
    const err = e as any;
    const code = err?.code ?? err?.cause?.code;
    const message =
      code === 'ECONNREFUSED' ? `Connection refused at ${url}.`
      : code === 'EHOSTUNREACH' || code === 'ETIMEDOUT' ? `Cannot reach ${url} from the cluster.`
      : err?.message ?? String(e);
    this.state = { ...this.state, configured: true, connected: false, error: message };
    this.emit('update');
    this.teardown();
    const delay = Math.min(2000 * 2 ** (this.failures - 1), 60_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (gen === this.generation) void this.connect(url, apiKey, username, gen);
    }, delay);
  }

  private async refreshAlerts() {
    try {
      const alerts = await this.call<any[]>('alert.list');
      this.state.alerts = alerts
        .map((a) => ({ uuid: a.uuid, level: a.level, klass: a.klass, formatted: (a.formatted ?? a.text ?? '').replace(/<[^>]+>/g, ''), datetime: a.datetime?.$date ?? a.datetime, dismissed: !!a.dismissed }))
        .sort((a, b) => (b.datetime ?? 0) - (a.datetime ?? 0));
      this.state.lastUpdate = Date.now();
      this.emit('update');
    } catch {
      /* the connection handler reports failures */
    }
  }

  private async refresh() {
    clearTimeout(this.refreshTimer);
    try {
      const [info, pools, datasets] = await Promise.all([
        this.call<any>('system.info'),
        this.call<any[]>('pool.query'),
        this.call<any[]>('pool.dataset.query', [[], { extra: { flat: true, retrieve_children: true } }]),
      ]);
      this.state.system = {
        hostname: info.hostname,
        version: info.version,
        uptimeSeconds: info.uptime_seconds ?? 0,
        loadavg: info.loadavg ?? [],
        physmem: info.physmem ?? 0,
        cores: info.cores ?? 0,
        model: info.model,
      };
      this.state.pools = pools.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        healthy: !!p.healthy,
        size: num(p.size),
        allocated: num(p.allocated),
        free: num(p.free),
        scan: p.scan ? { function: p.scan.function, state: p.scan.state, end_time: p.scan.end_time?.$date, errors: p.scan.errors, percentage: p.scan.percentage } : undefined,
        vdevErrors: countErrors(p.topology),
      }));
      this.state.datasets = datasets
        .filter((d) => d.type === 'FILESYSTEM' || d.type === 'VOLUME')
        .map((d) => ({ id: d.id, pool: d.pool, used: num(d.used), available: num(d.available), type: d.type, mountpoint: d.mountpoint, encrypted: !!d.encrypted, compression: d.compression?.value }))
        .sort((a, b) => a.id.localeCompare(b.id));
      await this.refreshAlerts();
      this.state.lastUpdate = Date.now();
      this.emit('update');
    } catch (e) {
      this.state.error = e instanceof Error ? e.message : String(e);
      this.emit('update');
    }
    this.refreshTimer = setTimeout(() => void this.refresh(), 30_000);
  }

  async test(url: string, apiKey: string, username?: string): Promise<string> {
    const u = new URL(url.includes('://') ? url : `wss://${url}`);
    const secure = u.protocol === 'wss:' || u.protocol === 'https:';
    const version = await pickApiVersion(`${secure ? 'https' : 'http'}://${u.host}`);
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${secure ? 'wss' : 'ws'}://${u.host}/api/${version}`, { rejectUnauthorized: false, handshakeTimeout: 8000 });
      const done = (fn: () => void) => {
        ws.terminate();
        fn();
      };
      let id = 1;
      ws.on('open', () => {
        ws.send(JSON.stringify(username ? { jsonrpc: '2.0', id, method: 'auth.login_ex', params: [{ mechanism: 'API_KEY_PLAIN', username, api_key: apiKey }] } : { jsonrpc: '2.0', id, method: 'auth.login_with_api_key', params: [apiKey] }));
      });
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.id === 1) {
          const ok = msg.result === true || msg.result?.response_type === 'SUCCESS';
          if (!ok) return done(() => reject(new Error(msg.error?.message ?? 'API key rejected')));
          id = 2;
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'system.version', params: [] }));
        } else if (msg.id === 2) done(() => resolve(`Connected to ${msg.result} (API ${version})`));
      });
      ws.on('error', (e) => done(() => reject(e)));
    });
  }
}

function countErrors(topology: any): number {
  let n = 0;
  const walk = (v: any) => {
    if (!v) return;
    const s = v.stats ?? {};
    n += (s.read_errors ?? 0) + (s.write_errors ?? 0) + (s.checksum_errors ?? 0);
    for (const c of v.children ?? []) walk(c);
  };
  for (const group of Object.values(topology ?? {})) for (const v of (group as any[]) ?? []) walk(v);
  return n;
}

export const truenas = new TrueNas();
