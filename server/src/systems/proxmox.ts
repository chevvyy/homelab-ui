// Proxmox VE: polled every few seconds (it has no watch API) with a scoped API token.
// Read access plus power (start/shutdown/stop/reboot) and snapshot actions.
import { EventEmitter } from 'node:events';
import { Agent, fetch } from 'undici';
import { config } from '../config.js';
import { readSecret } from '../secrets.js';

export interface PveNode {
  node: string;
  status: string;
  cpu: number; // 0..1
  maxcpu: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime: number;
}

export interface PveGuest {
  id: string; // "qemu/100"
  vmid: number;
  type: 'qemu' | 'lxc';
  name: string;
  node: string;
  status: string;
  cpu: number;
  maxcpu: number;
  mem: number;
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime: number;
  template: boolean;
  tags?: string;
}

export interface PveStorage {
  id: string;
  storage: string;
  node: string;
  status: string;
  disk: number;
  maxdisk: number;
  content?: string;
  shared: boolean;
}

export interface ProxmoxState {
  configured: boolean;
  connected: boolean;
  error?: string;
  lastUpdate?: number;
  version?: string;
  nodes: PveNode[];
  guests: PveGuest[];
  storage: PveStorage[];
}

// Proxmox uses a self-signed certificate by default; the connection stays on the LAN.
const insecure = new Agent({ connect: { rejectUnauthorized: false }, headersTimeout: 10_000, bodyTimeout: 15_000 });

class Proxmox extends EventEmitter {
  state: ProxmoxState = { configured: false, connected: false, nodes: [], guests: [], storage: [] };
  private creds?: { url: string; tokenId: string; secret: string };
  private timer?: NodeJS.Timeout;
  private failures = 0;

  async start() {
    await this.reload();
  }

  async reload() {
    clearTimeout(this.timer);
    const s = await readSecret('proxmox').catch(() => undefined);
    if (!s?.url || !s.tokenId || !s.secret) {
      this.creds = undefined;
      this.state = { configured: false, connected: false, nodes: [], guests: [], storage: [], error: 'Not configured: add the Proxmox URL and API token in Settings.' };
      this.emit('update');
      this.timer = setTimeout(() => void this.reload(), 60_000);
      return;
    }
    this.creds = { url: s.url.replace(/\/+$/, ''), tokenId: s.tokenId, secret: s.secret };
    this.failures = 0;
    void this.poll();
  }

  async api<T = any>(method: string, path: string, body?: Record<string, string | number>): Promise<T> {
    if (!this.creds) throw new Error('Proxmox is not configured.');
    const res = await fetch(`${this.creds.url}/api2/json${path}`, {
      method,
      dispatcher: insecure,
      headers: {
        Authorization: `PVEAPIToken=${this.creds.tokenId}=${this.creds.secret}`,
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: body ? new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString() : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = res.statusText;
      try {
        const j = JSON.parse(text);
        msg = j.message ?? (j.errors ? JSON.stringify(j.errors) : msg);
      } catch {
        /* keep statusText */
      }
      if (res.status === 401) msg = 'Proxmox rejected the API token (401). Check the token ID and secret in Settings.';
      if (res.status === 403) msg = `The API token lacks a permission for this action (403): ${msg}`;
      throw Object.assign(new Error(msg), { status: res.status });
    }
    return JSON.parse(text).data as T;
  }

  private async poll() {
    if (!this.creds) return;
    try {
      const resources = await this.api<any[]>('GET', '/cluster/resources');
      if (!this.state.version) this.state.version = (await this.api<any>('GET', '/version').catch(() => undefined))?.version;
      this.state = {
        ...this.state,
        configured: true,
        connected: true,
        error: undefined,
        lastUpdate: Date.now(),
        nodes: resources.filter((r) => r.type === 'node').map((r) => ({ node: r.node, status: r.status, cpu: r.cpu ?? 0, maxcpu: r.maxcpu ?? 0, mem: r.mem ?? 0, maxmem: r.maxmem ?? 0, disk: r.disk ?? 0, maxdisk: r.maxdisk ?? 0, uptime: r.uptime ?? 0 })),
        guests: resources
          .filter((r) => r.type === 'qemu' || r.type === 'lxc')
          .map((r) => ({ id: r.id, vmid: r.vmid, type: r.type, name: r.name ?? `${r.type}-${r.vmid}`, node: r.node, status: r.status, cpu: r.cpu ?? 0, maxcpu: r.maxcpu ?? 0, mem: r.mem ?? 0, maxmem: r.maxmem ?? 0, disk: r.disk ?? 0, maxdisk: r.maxdisk ?? 0, uptime: r.uptime ?? 0, template: !!r.template, tags: r.tags }))
          .sort((a, b) => a.vmid - b.vmid),
        storage: resources.filter((r) => r.type === 'storage').map((r) => ({ id: r.id, storage: r.storage, node: r.node, status: r.status, disk: r.disk ?? 0, maxdisk: r.maxdisk ?? 0, content: r.content, shared: !!r.shared })),
      };
      this.failures = 0;
    } catch (e) {
      this.failures++;
      this.state = { ...this.state, configured: true, connected: false, error: describe(e, this.creds.url) };
    }
    this.emit('update');
    // Back off while disconnected: 5s, 10s, 20s ... capped at 60s.
    const delay = this.failures ? Math.min(config.proxmoxPollMs * 2 ** (this.failures - 1), 60_000) : config.proxmoxPollMs;
    this.timer = setTimeout(() => void this.poll(), delay);
  }

  findGuest(vmid: number): PveGuest {
    const g = this.state.guests.find((x) => x.vmid === vmid);
    if (!g) throw Object.assign(new Error(`No VM or container with ID ${vmid}.`), { status: 404 });
    return g;
  }

  async power(vmid: number, action: 'start' | 'shutdown' | 'stop' | 'reboot') {
    const g = this.findGuest(vmid);
    if (g.template) throw Object.assign(new Error('Templates cannot be started.'), { status: 422 });
    const upid = await this.api<string>('POST', `/nodes/${g.node}/${g.type}/${vmid}/status/${action}`, {});
    setTimeout(() => void this.poll(), 1500);
    return { upid };
  }

  async snapshots(vmid: number) {
    const g = this.findGuest(vmid);
    const list = await this.api<any[]>('GET', `/nodes/${g.node}/${g.type}/${vmid}/snapshot`);
    return list.filter((s) => s.name !== 'current').map((s) => ({ name: s.name, description: s.description ?? '', time: s.snaptime ? s.snaptime * 1000 : undefined, vmstate: !!s.vmstate })).sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  }

  async snapshot(vmid: number, name: string, description = '') {
    if (!/^[A-Za-z][A-Za-z0-9_-]{1,39}$/.test(name)) throw Object.assign(new Error('Snapshot names must start with a letter and use letters, digits, - and _ (2-40 chars).'), { status: 422 });
    const g = this.findGuest(vmid);
    const upid = await this.api<string>('POST', `/nodes/${g.node}/${g.type}/${vmid}/snapshot`, { snapname: name, description });
    return { upid };
  }

  async test(url: string, tokenId: string, secret: string): Promise<string> {
    const res = await fetch(`${url.replace(/\/+$/, '')}/api2/json/version`, { dispatcher: insecure, headers: { Authorization: `PVEAPIToken=${tokenId}=${secret}` } });
    if (!res.ok) throw new Error(res.status === 401 ? 'Token rejected (401)' : `HTTP ${res.status}`);
    const j: any = await res.json();
    return `Connected to Proxmox VE ${j.data?.version ?? ''}`.trim();
  }
}

function describe(e: unknown, url: string): string {
  const err = e as any;
  const code = err?.cause?.code ?? err?.code;
  if (code === 'ECONNREFUSED') return `Connection refused at ${url}. Is Proxmox running and is the port (usually 8006) right?`;
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT' || code === 'EHOSTUNREACH') return `Cannot reach ${url} from the cluster (timeout).`;
  if (code === 'ENOTFOUND') return `Hostname in ${url} does not resolve.`;
  return err?.message ?? String(e);
}

export const proxmox = new Proxmox();
