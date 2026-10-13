// Minimal Kubernetes API client. @kubernetes/client-node is used only to load credentials
// (in-cluster ServiceAccount or a local kubeconfig); requests go straight to the API so we
// control watches, server-side apply, dry runs and log streams.
import http from 'node:http';
import https from 'node:https';
import { KubeConfig } from '@kubernetes/client-node';

export interface KObject {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    resourceVersion?: string;
    creationTimestamp?: string;
    ownerReferences?: { kind: string; name: string; uid: string; controller?: boolean }[];
    generation?: number;
    deletionTimestamp?: string;
    [k: string]: unknown;
  };
  spec?: any;
  status?: any;
  [k: string]: any;
}

export class K8sError extends Error {
  constructor(
    public status: number,
    public reason: string,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
}

const kc = new KubeConfig();
kc.loadFromDefault();
const cluster = kc.getCurrentCluster();
if (!cluster) throw new Error('No Kubernetes cluster configured');
const base = new URL(cluster.server);
const transport = base.protocol === 'https:' ? https : http;

async function requestOptions(method: string, path: string, headers: Record<string, string>) {
  const opts: https.RequestOptions = {
    method,
    hostname: base.hostname,
    port: base.port || (base.protocol === 'https:' ? 443 : 80),
    path: (base.pathname.replace(/\/$/, '') || '') + path,
    headers: { Accept: 'application/json', ...headers },
  };
  await kc.applyToHTTPSOptions(opts);
  return opts;
}

export interface RequestInit {
  body?: unknown;
  contentType?: string;
  query?: Record<string, string | number | boolean | undefined>;
}

function withQuery(path: string, query?: RequestInit['query']): string {
  if (!query) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${path}${path.includes('?') ? '&' : '?'}${s}` : path;
}

export async function request<T = any>(method: string, path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: string | undefined;
  if (init.body !== undefined) {
    payload = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
    headers['Content-Type'] = init.contentType ?? 'application/json';
    headers['Content-Length'] = String(Buffer.byteLength(payload));
  }
  const opts = await requestOptions(method, withQuery(path, init.query), headers);
  return new Promise<T>((resolve, reject) => {
    const req = transport.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data: any = text;
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          /* non-JSON body (e.g. logs) */
        }
        const status = res.statusCode ?? 0;
        if (status >= 400) {
          reject(new K8sError(status, data?.reason ?? 'Unknown', data?.message ?? text ?? `HTTP ${status}`, data?.details));
        } else resolve(data as T);
      });
    });
    req.setTimeout(30_000, () => req.destroy(new Error(`Kubernetes API timeout: ${method} ${path}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Streams a long-lived response line by line (watches, follow logs). Resolves when the stream
// ends; abort with the signal.
export async function streamLines(
  path: string,
  query: RequestInit['query'],
  onLine: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const opts = await requestOptions('GET', withQuery(path, query), {});
  return new Promise<void>((resolve, reject) => {
    const req = transport.request(opts, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 400) {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data: any = {};
          try {
            data = JSON.parse(text);
          } catch {
            /* ignore */
          }
          reject(new K8sError(status, data.reason ?? 'Unknown', data.message ?? text));
        });
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line) onLine(line);
        }
      });
      res.on('end', () => {
        if (buf) onLine(buf);
        resolve();
      });
      res.on('error', reject);
    });
    req.on('error', (e) => (signal?.aborted ? resolve() : reject(e)));
    signal?.addEventListener('abort', () => req.destroy(), { once: true });
    req.end();
  });
}

// ---- Resource paths -------------------------------------------------------------------------

export interface ResourceType {
  group: string; // "" for core
  version: string;
  plural: string;
  kind: string;
  namespaced: boolean;
}

export const R = {
  namespaces: { group: '', version: 'v1', plural: 'namespaces', kind: 'Namespace', namespaced: false },
  nodes: { group: '', version: 'v1', plural: 'nodes', kind: 'Node', namespaced: false },
  pods: { group: '', version: 'v1', plural: 'pods', kind: 'Pod', namespaced: true },
  services: { group: '', version: 'v1', plural: 'services', kind: 'Service', namespaced: true },
  events: { group: '', version: 'v1', plural: 'events', kind: 'Event', namespaced: true },
  pvcs: { group: '', version: 'v1', plural: 'persistentvolumeclaims', kind: 'PersistentVolumeClaim', namespaced: true },
  configmaps: { group: '', version: 'v1', plural: 'configmaps', kind: 'ConfigMap', namespaced: true },
  secrets: { group: '', version: 'v1', plural: 'secrets', kind: 'Secret', namespaced: true },
  serviceaccounts: { group: '', version: 'v1', plural: 'serviceaccounts', kind: 'ServiceAccount', namespaced: true },
  deployments: { group: 'apps', version: 'v1', plural: 'deployments', kind: 'Deployment', namespaced: true },
  replicasets: { group: 'apps', version: 'v1', plural: 'replicasets', kind: 'ReplicaSet', namespaced: true },
  statefulsets: { group: 'apps', version: 'v1', plural: 'statefulsets', kind: 'StatefulSet', namespaced: true },
  daemonsets: { group: 'apps', version: 'v1', plural: 'daemonsets', kind: 'DaemonSet', namespaced: true },
  jobs: { group: 'batch', version: 'v1', plural: 'jobs', kind: 'Job', namespaced: true },
  cronjobs: { group: 'batch', version: 'v1', plural: 'cronjobs', kind: 'CronJob', namespaced: true },
  ingresses: { group: 'networking.k8s.io', version: 'v1', plural: 'ingresses', kind: 'Ingress', namespaced: true },
  ingressroutes: { group: 'traefik.io', version: 'v1alpha1', plural: 'ingressroutes', kind: 'IngressRoute', namespaced: true },
  middlewares: { group: 'traefik.io', version: 'v1alpha1', plural: 'middlewares', kind: 'Middleware', namespaced: true },
} satisfies Record<string, ResourceType>;

export type ResourceKey = keyof typeof R;

export function resourcePath(rt: ResourceType, namespace?: string, name?: string, sub?: string): string {
  const prefix = rt.group ? `/apis/${rt.group}/${rt.version}` : `/api/${rt.version}`;
  let p = prefix;
  if (rt.namespaced && namespace) p += `/namespaces/${encodeURIComponent(namespace)}`;
  p += `/${rt.plural}`;
  if (name) p += `/${encodeURIComponent(name)}`;
  if (sub) p += `/${sub}`;
  return p;
}

// Discovery cache: kind+apiVersion -> resource type, used to apply arbitrary user YAML.
const discovered = new Map<string, ResourceType>();

export async function resolveKind(apiVersion: string, kind: string): Promise<ResourceType> {
  const key = `${apiVersion}/${kind}`;
  const hit = discovered.get(key);
  if (hit) return hit;
  const [group, version] = apiVersion.includes('/') ? apiVersion.split('/') : ['', apiVersion];
  const path = group ? `/apis/${group}/${version}` : `/api/${version}`;
  let list: any;
  try {
    list = await request('GET', path);
  } catch (e) {
    if (e instanceof K8sError && e.status === 404) {
      throw new K8sError(422, 'UnknownApiVersion', `The cluster does not serve apiVersion "${apiVersion}".`);
    }
    throw e;
  }
  for (const r of list.resources ?? []) {
    if (r.name.includes('/')) continue;
    discovered.set(`${apiVersion}/${r.kind}`, { group, version, plural: r.name, kind: r.kind, namespaced: r.namespaced });
  }
  const found = discovered.get(key);
  if (!found) throw new K8sError(422, 'UnknownKind', `The cluster has no kind "${kind}" in ${apiVersion}.`);
  return found;
}

export const FIELD_MANAGER = 'homelab-ui';
