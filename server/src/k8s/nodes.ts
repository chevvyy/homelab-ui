// Node summaries plus live CPU/memory from metrics-server (polled; it has no watch API).
import { EventEmitter } from 'node:events';
import { cache } from './cache.js';
import { request } from './client.js';

export interface NodeSummary {
  name: string;
  ready: boolean;
  schedulable: boolean;
  roles: string[];
  internalIP?: string;
  kubelet?: string;
  os?: string;
  cpuCores: number;
  memoryBytes: number;
  cpuUsage?: number; // cores
  memoryUsage?: number; // bytes
  pods: number;
  podCapacity: number;
  pressure: string[];
  age?: string;
}

export function parseCpu(q: string | undefined): number {
  if (!q) return 0;
  if (q.endsWith('n')) return Number(q.slice(0, -1)) / 1e9;
  if (q.endsWith('u')) return Number(q.slice(0, -1)) / 1e6;
  if (q.endsWith('m')) return Number(q.slice(0, -1)) / 1e3;
  return Number(q);
}

const UNITS: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };

export function parseBytes(q: string | undefined): number {
  if (!q) return 0;
  const m = /^(\d+(?:\.\d+)?)([KMGT]i?)?$/.exec(q);
  if (!m) return Number(q) || 0;
  return Number(m[1]) * (m[2] ? UNITS[m[2]] : 1);
}

class Metrics extends EventEmitter {
  nodes = new Map<string, { cpu: number; memory: number }>();
  pods = new Map<string, { cpu: number; memory: number }>(); // ns/name
  available = false;

  start() {
    const tick = async () => {
      try {
        const [n, p] = await Promise.all([
          request<any>('GET', '/apis/metrics.k8s.io/v1beta1/nodes'),
          request<any>('GET', '/apis/metrics.k8s.io/v1beta1/pods'),
        ]);
        this.nodes = new Map((n.items ?? []).map((i: any) => [i.metadata.name, { cpu: parseCpu(i.usage?.cpu), memory: parseBytes(i.usage?.memory) }]));
        this.pods = new Map(
          (p.items ?? []).map((i: any) => [
            `${i.metadata.namespace}/${i.metadata.name}`,
            (i.containers ?? []).reduce((acc: any, c: any) => ({ cpu: acc.cpu + parseCpu(c.usage?.cpu), memory: acc.memory + parseBytes(c.usage?.memory) }), { cpu: 0, memory: 0 }),
          ]),
        );
        this.available = true;
        this.emit('update');
      } catch {
        this.available = false;
      }
    };
    void tick();
    setInterval(() => void tick(), 15_000).unref();
  }
}

export const metrics = new Metrics();

export function buildNodes(): NodeSummary[] {
  const pods = cache.list('pods');
  return cache
    .list('nodes')
    .map((n) => {
      const conds: any[] = n.status?.conditions ?? [];
      const usage = metrics.nodes.get(n.metadata.name);
      return {
        name: n.metadata.name,
        ready: conds.some((c) => c.type === 'Ready' && c.status === 'True'),
        schedulable: !n.spec?.unschedulable,
        roles: Object.keys(n.metadata.labels ?? {}).filter((l) => l.startsWith('node-role.kubernetes.io/')).map((l) => l.split('/')[1]),
        internalIP: (n.status?.addresses ?? []).find((a: any) => a.type === 'InternalIP')?.address,
        kubelet: n.status?.nodeInfo?.kubeletVersion,
        os: n.status?.nodeInfo?.osImage,
        cpuCores: parseCpu(n.status?.allocatable?.cpu),
        memoryBytes: parseBytes(n.status?.allocatable?.memory),
        cpuUsage: usage?.cpu,
        memoryUsage: usage?.memory,
        pods: pods.filter((p) => p.spec?.nodeName === n.metadata.name && !['Succeeded', 'Failed'].includes(p.status?.phase)).length,
        podCapacity: Number(n.status?.allocatable?.pods ?? 110),
        pressure: conds.filter((c) => c.type !== 'Ready' && c.status === 'True').map((c) => c.type),
        age: n.metadata.creationTimestamp,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
